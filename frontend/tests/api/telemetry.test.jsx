import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  reportError,
  installGlobalErrorReporting,
  setTelemetryEnabled,
  setTelemetryWarehouse,
  _resetTelemetry,
} from '../../src/api/telemetry.js';
import ErrorBoundary from '../../src/components/common/ErrorBoundary.jsx';

/**
 * Client error reporting.
 *
 * The gap this closes is small to describe - "a render error in a deployed
 * build is invisible unless a user reports it" - and easy to close badly.
 * Most of these tests are about the ways a reporter must *not* behave:
 * never throw from an error path, never retry into a loop, never report the
 * same re-rendering failure twice a second.
 */
let fetchMock;

beforeEach(() => {
  _resetTelemetry();
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reportError', () => {
  it('sends nothing when nobody is signed in', async () => {
    // The endpoint requires a session, so this would be a guaranteed 401 -
    // and a sign-in screen is not a place to be generating auth failures.
    expect(await reportError(new Error('boom'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the failure once a session exists', async () => {
    setTelemetryEnabled(true);
    const error = new Error('panel exploded');
    error.name = 'TypeError';

    expect(await reportError(error, { boundary: 'Orders' })).toBe(true);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/telemetry/client-errors');
    expect(options.method).toBe('POST');
    // The session cookie has to ride along - the endpoint is authenticated.
    expect(options.credentials).toBe('include');
    const body = JSON.parse(options.body);
    expect(body).toMatchObject({
      message: 'panel exploded',
      name: 'TypeError',
      boundary: 'Orders',
    });
    expect(body.stack).toContain('Error');
  });

  it('attaches the warehouse being watched, so the report lands in its log', async () => {
    setTelemetryEnabled(true);
    setTelemetryWarehouse('507f1f77bcf86cd799439011');

    await reportError(new Error('boom'));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).warehouseId).toBe(
      '507f1f77bcf86cd799439011'
    );
  });

  it('reports the same failure only once', async () => {
    // The failure mode this is most likely to meet is a render error in a
    // component that re-renders on every tick - twice a second, forever.
    setTelemetryEnabled(true);

    for (let i = 0; i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      await reportError(new Error('the same broken panel'));
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still reports genuinely different failures', async () => {
    setTelemetryEnabled(true);
    await reportError(new Error('first'));
    await reportError(new Error('second'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops after a hard ceiling of distinct failures', async () => {
    // Ten distinct failures is already a page that is not working; the
    // eleventh tells nobody anything the first ten did not.
    setTelemetryEnabled(true);
    for (let i = 0; i < 30; i++) {
      // eslint-disable-next-line no-await-in-loop
      await reportError(new Error(`failure ${i}`));
    }
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('never throws, whatever the network does', async () => {
    // This is called from an error path, frequently from inside a
    // component that has already failed. A reporter that can throw turns
    // one broken panel into a broken page.
    setTelemetryEnabled(true);
    fetchMock.mockRejectedValue(new Error('network is down'));

    await expect(reportError(new Error('boom'))).resolves.toBe(false);
  });

  it('does not retry a failed report', async () => {
    setTelemetryEnabled(true);
    fetchMock.mockRejectedValue(new Error('network is down'));

    await reportError(new Error('boom'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('handles being given something that is not an Error', async () => {
    setTelemetryEnabled(true);
    await reportError('just a string');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message).toBe('just a string');

    await reportError(null);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).message).toBe('Unknown error');
  });

  it('truncates an unbounded stack rather than posting it whole', async () => {
    setTelemetryEnabled(true);
    const error = new Error('boom');
    error.stack = 'x'.repeat(100000);

    await reportError(error);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stack.length).toBeLessThanOrEqual(20000);
  });

  it('marks the request keepalive so a navigation cannot cancel it', async () => {
    // The navigation in question is frequently caused by the very error
    // being reported.
    setTelemetryEnabled(true);
    await reportError(new Error('boom'));
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
  });
});

describe('global error reporting', () => {
  it('catches errors that never reach a React boundary', async () => {
    // A boundary only sees errors thrown during render. A socket handler,
    // a timer, an event listener - none of those pass through one.
    setTelemetryEnabled(true);
    const target = new EventTarget();
    const teardown = installGlobalErrorReporting(target);

    const event = new Event('error');
    // @ts-ignore - ErrorEvent's shape, without jsdom's constructor quirks
    event.error = new Error('thrown from a timer');
    target.dispatchEvent(event);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      message: 'thrown from a timer',
      boundary: 'window.onerror',
    });
    teardown();
  });

  it('catches promise rejections nobody awaited', async () => {
    setTelemetryEnabled(true);
    const target = new EventTarget();
    const teardown = installGlobalErrorReporting(target);

    const event = new Event('unhandledrejection');
    // @ts-ignore
    event.reason = new Error('a fetch nobody caught');
    target.dispatchEvent(event);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).boundary).toBe('unhandledrejection');
    teardown();
  });

  it('stops listening once torn down', async () => {
    setTelemetryEnabled(true);
    const target = new EventTarget();
    installGlobalErrorReporting(target)();

    const event = new Event('error');
    // @ts-ignore
    event.error = new Error('after teardown');
    target.dispatchEvent(event);

    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ErrorBoundary', () => {
  function Boom() {
    throw new Error('render failed on purpose');
  }

  it('still shows the fallback and keeps the rest of the page alive', () => {
    setTelemetryEnabled(true);
    render(
      <div>
        <ErrorBoundary label="Orders">
          <Boom />
        </ErrorBoundary>
        <p>the rest of the dashboard</p>
      </div>
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Orders stopped working');
    expect(screen.getByText('the rest of the dashboard')).toBeInTheDocument();
  });

  it('reports the failure, with the component stack and the boundary name', async () => {
    setTelemetryEnabled(true);
    render(
      <ErrorBoundary label="Orders">
        <Boom />
      </ErrorBoundary>
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ message: 'render failed on purpose', boundary: 'Orders' });
    expect(body.componentStack).toContain('Boom');
  });

  it('keeps logging to the console, which works when the report does not', () => {
    setTelemetryEnabled(true);
    render(
      <ErrorBoundary label="Orders">
        <Boom />
      </ErrorBoundary>
    );
    expect(console.error).toHaveBeenCalled();
  });

  it('renders its fallback even when reporting is impossible', async () => {
    setTelemetryEnabled(true);
    fetchMock.mockRejectedValue(new Error('network is down'));

    render(
      <ErrorBoundary label="Orders">
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('still offers a retry', async () => {
    setTelemetryEnabled(true);
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error('first time only');
      return <p>recovered</p>;
    }

    render(
      <ErrorBoundary label="Orders">
        <Flaky />
      </ErrorBoundary>
    );

    shouldThrow = false;
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
  });
});

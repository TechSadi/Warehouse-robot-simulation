import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as api from '../../src/api/client.js';
import { ApiError, describeError } from '../../src/api/errors.js';

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function noContent() {
  return { ok: true, status: 204, json: async () => null };
}

describe('api client', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    document.cookie = 'wrs_csrf=csrf-token-value';
    api.setUnauthenticatedHandler(null);
  });

  afterEach(() => {
    api.setUnauthenticatedHandler(null);
  });

  it('sends cookies on every request, since the session lives in them', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ success: true, data: { status: 'ok' } }));

    await api.getHealth();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/health'),
      expect.objectContaining({ credentials: 'include' })
    );
  });

  it('echoes the CSRF cookie back as a header on state-changing calls only', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ success: true, data: {} }));

    await api.getHealth();
    const [, getOptions] = global.fetch.mock.calls[0];
    expect(getOptions.headers['X-CSRF-Token']).toBeUndefined();

    await api.dispatchOrders('w1');
    const [, postOptions] = global.fetch.mock.calls[1];
    expect(postOptions.headers['X-CSRF-Token']).toBe('csrf-token-value');
  });

  it('unwraps the API envelope so callers get the payload, not the wrapper', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ success: true, data: { _id: 'w1', name: 'Depot' } }));

    await expect(api.getWarehouse('w1')).resolves.toEqual({ _id: 'w1', name: 'Depot' });
  });

  it('handles a 204 with no body (DELETE) without trying to parse it', async () => {
    global.fetch.mockResolvedValue(noContent());

    await expect(api.deleteWarehouse('w1')).resolves.toEqual({});
  });

  describe('errors', () => {
    it('turns a network failure into an ApiError instead of leaking "Failed to fetch"', async () => {
      global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));

      const error = await api.getHealth().catch((err) => err);

      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(0);
      expect(error.isNetworkError).toBe(true);
      expect(describeError(error)).toMatch(/reach the server/i);
    });

    it('lets an aborted request stay an AbortError, so callers can ignore it', async () => {
      const abort = new Error('aborted');
      abort.name = 'AbortError';
      global.fetch.mockRejectedValue(abort);

      const error = await api.getHealth().catch((err) => err);

      expect(error.name).toBe('AbortError');
    });

    it("carries the server's message and validation details", async () => {
      global.fetch.mockResolvedValue(
        jsonResponse(
          {
            success: false,
            error: {
              message: 'Validation failed',
              details: [{ field: 'rows', message: 'must be between 5 and 80' }],
            },
          },
          { status: 400 }
        )
      );

      const error = await api.createWarehouse({ rows: 1 }).catch((err) => err);

      expect(error.status).toBe(400);
      expect(describeError(error)).toBe('Validation failed (rows: must be between 5 and 80)');
    });

    it('replaces an unhelpful generic failure with an actionable sentence', async () => {
      global.fetch.mockResolvedValue(jsonResponse({}, { status: 429 }));

      const error = await api.dispatchOrders('w1').catch((err) => err);

      expect(describeError(error)).toMatch(/too many requests/i);
    });
  });

  describe('session refresh', () => {
    it('refreshes once and retries the original request after a 401', async () => {
      global.fetch
        .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
        .mockResolvedValueOnce(jsonResponse({ success: true }))
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [{ id: 'r1' }] }));

      const result = await api.listRobots('w1');

      expect(global.fetch.mock.calls[1][0]).toContain('/api/auth/refresh');
      expect(result.data).toEqual([{ id: 'r1' }]);
    });

    it('refreshes on /auth/me too, so a reload after the access token expires keeps the session', async () => {
      // This is the regression the previous client had: /auth/me matched a
      // blanket "never retry /auth/*" rule, so reloading the tab 15 minutes
      // after signing in signed the user out despite a valid refresh token.
      global.fetch
        .mockResolvedValueOnce(jsonResponse({}, { status: 401 }))
        .mockResolvedValueOnce(jsonResponse({ success: true }))
        .mockResolvedValueOnce(jsonResponse({ success: true, data: { user: { id: 'u1' } } }));

      const user = await api.getCurrentUser();

      expect(global.fetch.mock.calls[1][0]).toContain('/api/auth/refresh');
      expect(user).toEqual({ id: 'u1' });
    });

    it('never tries to refresh a failed login - that would be circular', async () => {
      global.fetch.mockResolvedValue(
        jsonResponse({ success: false, error: { message: 'Invalid email or password' } }, { status: 401 })
      );

      await api.login({ email: 'a@b.c', password: 'nope' }).catch(() => {});

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch.mock.calls[0][0]).toContain('/api/auth/login');
    });

    it('serialises concurrent refreshes into one, so the refresh token rotates once', async () => {
      // Two parallel requests both 401. Without serialisation each would
      // rotate the refresh token, invalidating the other - which the
      // server's reuse detection correctly reads as token theft.
      let refreshCalls = 0;
      global.fetch.mockImplementation(async (url) => {
        if (String(url).includes('/auth/refresh')) {
          refreshCalls += 1;
          return jsonResponse({ success: true });
        }
        if (refreshCalls === 0) return jsonResponse({}, { status: 401 });
        return jsonResponse({ success: true, data: [] });
      });

      await Promise.all([api.listRobots('w1'), api.listOrders('w1')]);

      expect(refreshCalls).toBe(1);
    });

    it('reports a lost session when the refresh itself fails', async () => {
      const onUnauthenticated = vi.fn();
      api.setUnauthenticatedHandler(onUnauthenticated);

      global.fetch.mockImplementation(async (url) =>
        String(url).includes('/auth/refresh')
          ? jsonResponse({}, { status: 401 })
          : jsonResponse({}, { status: 401 })
      );

      await api.listRobots('w1').catch(() => {});

      expect(onUnauthenticated).toHaveBeenCalled();
    });

    it('resolves to null rather than throwing when nobody is signed in', async () => {
      global.fetch.mockResolvedValue(jsonResponse({}, { status: 401 }));

      await expect(api.getCurrentUser()).resolves.toBeNull();
    });

    it('does not attempt a refresh when the browser holds no session at all', async () => {
      // /auth/refresh shares the authentication rate limiter, which counts
      // failures. Firing a doomed refresh on every signed-out page load
      // spends that budget on requests that cannot succeed - and then the
      // visitor cannot sign in either, because login shares the same budget.
      document.cookie = 'wrs_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      global.fetch.mockResolvedValue(jsonResponse({}, { status: 401 }));

      await expect(api.getCurrentUser()).resolves.toBeNull();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch.mock.calls[0][0]).toContain('/api/auth/me');
    });
  });

  describe('obstacles', () => {
    it('posts a new obstacle to the warehouse it belongs to', async () => {
      global.fetch.mockResolvedValue(jsonResponse({ success: true, data: { id: 'o1' } }, { status: 201 }));

      await api.addObstacle('w1', { id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 2 }] });

      const [url, options] = global.fetch.mock.calls[0];
      expect(url).toContain('/api/warehouses/w1/obstacles');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toMatchObject({ type: 'human_worker' });
    });

    it('encodes obstacle ids so an id with a slash cannot escape its path', async () => {
      global.fetch.mockResolvedValue(noContent());

      await api.removeObstacle('w1', 'a/b');

      expect(global.fetch.mock.calls[0][0]).toContain('/obstacles/a%2Fb');
    });
  });
});

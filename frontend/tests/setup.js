import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// `findBy*` and `waitFor` default to giving up after 1s. That is plenty on an
// idle machine - the whole suite runs in ~25s - but this suite spins up 16
// jsdom environments in parallel, and jsdom setup alone is over half the
// wall time. On a loaded machine (a CI runner, or a local run alongside
// `lint`/`typecheck`) the same run takes ~70s, and a sign-in that normally
// settles in well under a second can miss the 1s window.
//
// The failure mode is worse than one red test: `userEvent.type` is abandoned
// mid-word when the test times out, and because it re-queries the DOM
// between fields, its next query resolves against the *following* test's
// freshly rendered form - so two sign-ins interleave character by character
// into one input and that test fails too. Five seconds is still a real
// ceiling on a hang; it just is not a stopwatch on how busy the host is.
configure({ asyncUtilTimeout: 5000 });

/**
 * Browser APIs jsdom does not implement that this app uses on every render.
 *
 * Stubbing them here rather than per test keeps each test file about the
 * behaviour it is checking. None of these are the subject of any assertion -
 * they exist so that mounting a component does not throw before the
 * interesting part runs.
 */

// The grid canvas observes its container to size the backing bitmap.
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Canvas: jsdom has the element but no 2D context. Every drawing call is a
// no-op; the tests assert on the React tree around the canvas, never on
// pixels, which is the honest limit of what jsdom can verify.
if (!HTMLCanvasElement.prototype.getContext.__stubbed) {
  const noop = () => {};
  const context = new Proxy(
    { canvas: null, globalAlpha: 1, lineWidth: 1 },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return noop;
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    }
  );
  const stub = () => context;
  stub.__stubbed = true;
  HTMLCanvasElement.prototype.getContext = stub;
}

global.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);

// Recharts' ResponsiveContainer measures its parent, which is always 0x0 in
// jsdom, so it renders nothing at all. Giving elements a nominal size lets
// the chart render enough to assert on.
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 200 });

if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

if (!global.URL.createObjectURL) {
  global.URL.createObjectURL = () => 'blob:mock';
  global.URL.revokeObjectURL = () => {};
}

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
});

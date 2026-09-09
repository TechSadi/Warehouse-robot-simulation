/**
 * Reporting the dashboard's own failures back to the server.
 *
 * `ErrorBoundary` logged to the console and stopped there, which meant a
 * render error in a deployed build was invisible unless a user thought to
 * mention it. That was the documented "no telemetry" gap, and the reason
 * given for it - that there is no telemetry backend and inventing one
 * would be scope nobody asked for - was right about the second half and
 * wrong about the first: this application already has a log, the user can
 * already read it, and a render failure belongs in it.
 *
 * So: no vendor, no SDK, no third party receiving anything. One authenticated
 * POST to this project's own API, which writes one server-authored log line
 * (see backend/src/controllers/telemetry.controller.js).
 *
 * The hard part of client error reporting is not sending the report, it is
 * not making things worse:
 *
 *  - **Never throw.** This is called from an error path, frequently from
 *    inside a component that has already failed. A reporter that can throw
 *    turns one broken panel into a broken page.
 *  - **Never retry.** A failed report is a report we lose. A retried
 *    report against a server that is down is a loop.
 *  - **Deduplicate.** The failure mode this is most likely to meet is a
 *    render error in a component that re-renders on every tick, which is
 *    twice a second, forever.
 *  - **Stay quiet when signed out.** The endpoint requires a session, and
 *    firing doomed requests at it from a sign-in screen is noise.
 */

const ENDPOINT = `${import.meta.env.VITE_API_URL || ''}/api/telemetry/client-errors`;

/** Reports already sent this page load, keyed by message + location. The
 * point is the re-rendering component: without this, one broken panel
 * reports itself on every tick. */
const seen = new Set();

/** A hard ceiling per page load, independent of deduplication. Ten
 * distinct failures is already a page that is not working; the eleventh
 * tells nobody anything the first ten did not. */
const MAX_REPORTS_PER_SESSION = 10;
let sent = 0;

/** Set by the auth provider. Reporting while signed out would be a
 * guaranteed 401, and this is not a path worth spending a refresh on. */
let isAuthenticated = false;
export function setTelemetryEnabled(enabled) {
  isAuthenticated = Boolean(enabled);
}

/** The warehouse currently being watched, so a report lands in the right
 * Logs panel. Set by the live-simulation hook; absent is fine. */
let currentWarehouseId = null;
export function setTelemetryWarehouse(warehouseId) {
  currentWarehouseId = warehouseId || null;
}

/**
 * What counts as "the same failure".
 *
 * Deliberately the error's identity and where it was caught, not its
 * stack. A stack looks like the more precise key and is not: V8 varies the
 * async frames it captures between the first throw and later ones, so two
 * reports of one repeating error can carry different stacks and defeat the
 * deduplication exactly when it is needed most - a component failing on
 * every tick.
 *
 * The cost is that two genuinely different errors that share a name,
 * message and boundary collapse into one report. That is the right way to
 * be wrong here: the second one adds a duplicate line to a log, and the
 * failure it describes is already recorded.
 */
function fingerprint(payload) {
  return `${payload.name || ''}|${payload.message}|${payload.boundary || ''}`;
}

/**
 * Sends one report. Resolves either way - the caller is in the middle of
 * handling a failure and has nothing useful to do with a second one.
 *
 * @param {unknown} error
 * @param {{boundary?: string, componentStack?: string}} [context]
 * @returns {Promise<boolean>} whether a report was actually sent
 */
export async function reportError(error, context = {}) {
  try {
    if (!isAuthenticated) return false;
    if (sent >= MAX_REPORTS_PER_SESSION) return false;

    // `unknown`, not `Error`: this is called from catch blocks and from
    // `unhandledrejection`, and a rejection can carry literally anything -
    // a string, a Response, undefined. Narrowing here rather than trusting
    // the caller is why the "not an Error" case has a test.
    const thrown = /** @type {any} */ (error);
    const payload = {
      message: String(thrown?.message ?? thrown ?? 'Unknown error').slice(0, 2000),
      name: thrown?.name ? String(thrown.name).slice(0, 200) : undefined,
      stack: thrown?.stack ? String(thrown.stack).slice(0, 20000) : undefined,
      componentStack: context.componentStack
        ? String(context.componentStack).slice(0, 20000)
        : undefined,
      boundary: context.boundary,
      url: typeof window !== 'undefined' ? window.location?.href?.slice(0, 2000) : undefined,
      warehouseId: currentWarehouseId || undefined,
    };

    const key = fingerprint(payload);
    if (seen.has(key)) return false;
    seen.add(key);
    sent += 1;

    // Deliberately not the shared `request()` helper from api/client.js.
    // That one retries through a token refresh on a 401 and notifies the
    // app when the session is gone - both correct for a user action and
    // both wrong here, where a failed report should simply be dropped
    // rather than triggering a token rotation or bouncing the user to a
    // sign-in screen because their error report did not land.
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // The report must not keep the page alive, and must not be
      // cancelled by a navigation that happens because of the very error
      // being reported.
      keepalive: true,
    });
    return response.ok;
  } catch {
    // Swallowed on purpose - see the note at the top of this file. A
    // reporter that can throw turns one broken panel into a broken page.
    return false;
  }
}

/**
 * Catches the failures that never reach a React boundary: errors thrown
 * from event handlers, timers and callbacks, and promise rejections nobody
 * awaited.
 *
 * `ErrorBoundary` only sees errors thrown during render. Most of what
 * actually breaks in this app - a socket handler, a fetch in an effect, a
 * canvas event listener - is outside that, and used to reach nothing but
 * the console.
 *
 * Returns a teardown function.
 */
export function installGlobalErrorReporting(target = window) {
  const onError = (event) => {
    reportError(event.error || event.message, { boundary: 'window.onerror' });
  };
  const onRejection = (event) => {
    reportError(event.reason, { boundary: 'unhandledrejection' });
  };

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Test-only: forgets what has been reported this page load. */
export function _resetTelemetry() {
  seen.clear();
  sent = 0;
  isAuthenticated = false;
  currentWarehouseId = null;
}

import { ApiError } from './errors.js';

// In local dev, Vite's proxy (see vite.config.js) forwards /api to the
// backend, so a relative path works with no configuration. A production
// build has no such proxy - if the frontend and backend are deployed as
// separate services (e.g. Vercel + Render, this project's documented
// deployment target - see DEPLOYMENT.md), a relative path would resolve
// against the frontend's own origin, which has no API to answer it. Set
// VITE_API_URL at build time to the backend's deployed origin to fix that;
// leave it unset for local dev or a same-origin deployment, and this
// falls back to the relative path exactly as before.
const API_BASE = `${import.meta.env.VITE_API_URL || ''}/api`;

const CSRF_COOKIE = 'wrs_csrf';
const CSRF_HEADER = 'X-CSRF-Token';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Auth endpoints that must never trigger the silent-refresh retry below.
 *
 * This used to be "any path starting with /auth", which quietly included
 * `/auth/me` - the call the app makes on every page load to find out who
 * is signed in. An access token lives 15 minutes and the refresh token 30
 * days, so reloading the tab 15 minutes after signing in produced a 401
 * that was never retried, and the app dropped the user back to the sign-in
 * screen while a perfectly valid refresh token sat in the cookie jar.
 * Only the endpoints that *establish* or *destroy* a session belong here:
 * refreshing in the middle of one of those is either circular or pointless.
 */
const NO_REFRESH_RETRY = ['/auth/login', '/auth/register', '/auth/refresh', '/auth/logout'];

/**
 * The session lives in httpOnly cookies the browser sets and sends on its
 * own - this code never sees, stores, or can leak the token. The two
 * things it must do are ask the browser to attach those cookies
 * (`credentials: 'include'`, required because the API is a different
 * origin in production) and echo the readable CSRF cookie back in a
 * header on state-changing calls, which is the half a cross-site attacker
 * cannot forge. See backend/src/middleware/csrf.js.
 */
function readCsrfToken() {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Notified when the server says the session is gone, so the app can drop
 * back to the sign-in screen instead of showing a wall of failed requests.
 * Registered by the auth provider (state/useAuth.jsx). */
let onUnauthenticated = null;
export function setUnauthenticatedHandler(handler) {
  onUnauthenticated = handler;
}

function notifyUnauthenticated() {
  if (onUnauthenticated) onUnauthenticated();
}

/** Serialises concurrent refresh attempts: a dashboard fires several
 * requests at once, and without this a single expired access token would
 * trigger one refresh per in-flight request - each rotating the refresh
 * token and invalidating the others, which the server's reuse detection
 * would correctly treat as theft and log the user out.
 *
 * The realtime layer shares this exact promise (see api/realtime.js): a
 * socket handshake rejected for an expired token and a REST call rejected
 * for the same expired token must not race each other into two rotations.
 */
let refreshInFlight = null;

/**
 * Whether there is any point asking for a refresh.
 *
 * The refresh token itself is httpOnly and unreadable, but the CSRF cookie
 * is set alongside it, cleared with it, and given the same lifetime
 * (backend/src/utils/tokens.js) - so its absence is a reliable "this
 * browser has no session".
 *
 * This matters because /auth/refresh is behind the authentication rate
 * limiter (10 per 15 minutes per IP, counting failures). Without this
 * check, every page load while signed out fired a doomed refresh: ten
 * reloads of the sign-in screen and the visitor had spent the whole budget
 * on requests that could never succeed - and then could not sign in,
 * because logging in shares that budget. Found by the end-to-end suite,
 * which reloads the signed-out page more often than a person would.
 */
function hasSessionCookies() {
  return readCsrfToken() !== null;
}

export function refreshSession() {
  if (!hasSessionCookies()) return Promise.resolve(false);
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { [CSRF_HEADER]: readCsrfToken() || '' },
    })
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function rawRequest(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };

  if (UNSAFE_METHODS.has(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  try {
    return await fetch(`${API_BASE}${path}`, {
      // Without this the browser sends no cookies to a cross-origin API, so
      // every request would be unauthenticated.
      credentials: 'include',
      ...options,
      headers,
    });
  } catch (err) {
    // An aborted request is the caller changing its mind, not a failure -
    // it must stay distinguishable so callers can drop the result silently
    // instead of showing the user an error they caused by navigating away.
    if (err && err.name === 'AbortError') throw err;
    // Everything else here is "the request never reached a server":
    // offline, DNS failure, connection refused, CORS rejection. Turning it
    // into an ApiError with status 0 gives the UI one error shape to
    // handle, instead of a bare TypeError leaking "Failed to fetch" on screen.
    throw new ApiError('Network request failed', { status: 0, cause: err });
  }
}

async function requestFull(path, options = {}, { retryOn401 = true } = {}) {
  let res = await rawRequest(path, options);

  // A 401 usually just means the short-lived access token lapsed. Try one
  // silent refresh before bothering the user for their password again.
  if (res.status === 401 && retryOn401 && !NO_REFRESH_RETRY.some((p) => path.startsWith(p))) {
    const refreshed = await refreshSession();
    if (refreshed) {
      res = await rawRequest(path, options);
    } else {
      notifyUnauthenticated();
    }
  }

  // 204 No Content (DELETE) has no body to parse.
  const body = res.status === 204 ? null : await res.json().catch(() => null);

  if (!res.ok) {
    if (res.status === 401) notifyUnauthenticated();
    const message = body?.error?.message || `Request failed: ${res.status}`;
    throw new ApiError(message, { status: res.status, details: body?.error?.details });
  }

  return body || {};
}

async function request(path, options = {}) {
  const body = await requestFull(path, options);
  return body.data;
}

export { requestFull, request };

export function getHealth(options) {
  return request('/health', options);
}

// --- Authentication ----------------------------------------------------------

export function register(payload) {
  return request('/auth/register', { method: 'POST', body: JSON.stringify(payload) });
}

export function login(payload) {
  return request('/auth/login', { method: 'POST', body: JSON.stringify(payload) });
}

export function logout() {
  return request('/auth/logout', { method: 'POST' });
}

/** Resolves to null rather than throwing when nobody is signed in - "not
 * signed in" is an ordinary state on first load, not an error. */
export async function getCurrentUser(options) {
  try {
    const data = await requestFull('/auth/me', options);
    return data.data?.user || null;
  } catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

// --- Warehouses --------------------------------------------------------------

export function createWarehouse(payload) {
  return request('/warehouses', { method: 'POST', body: JSON.stringify(payload) });
}

export function updateWarehouse(id, payload) {
  return request(`/warehouses/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
}

export function listWarehouses(params = {}, options = {}) {
  const query = new URLSearchParams({ limit: '50', ...params }).toString();
  return requestFull(`/warehouses?${query}`, options);
}

export function getWarehouse(id, options) {
  return request(`/warehouses/${id}`, options);
}

export function deleteWarehouse(id) {
  return requestFull(`/warehouses/${id}`, { method: 'DELETE' });
}

// --- Robots ----------------------------------------------------------------

export function listRobots(warehouseId, options = {}) {
  return requestFull(`/robots?warehouseId=${warehouseId}&limit=100`, options);
}

export function spawnRobot(payload) {
  return request('/robots', { method: 'POST', body: JSON.stringify(payload) });
}

export function assignRobotTask(robotId, destination) {
  return request(`/robots/${robotId}/tasks`, { method: 'POST', body: JSON.stringify({ destination }) });
}

// --- Orders ------------------------------------------------------------------

export function listOrders(warehouseId, params = {}, options = {}) {
  const query = new URLSearchParams({ warehouseId, limit: '100', ...params }).toString();
  return requestFull(`/orders?${query}`, options);
}

export function generateOrders(warehouseId, count) {
  return request(`/warehouses/${warehouseId}/orders/generate`, {
    method: 'POST',
    body: JSON.stringify({ count }),
  });
}

export function dispatchOrders(warehouseId) {
  return request(`/warehouses/${warehouseId}/orders/dispatch`, { method: 'POST' });
}

// --- Obstacles -----------------------------------------------------------

export function listObstacles(warehouseId, options = {}) {
  return requestFull(`/warehouses/${warehouseId}/obstacles`, options);
}

export function addObstacle(warehouseId, payload) {
  return request(`/warehouses/${warehouseId}/obstacles`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function removeObstacle(warehouseId, obstacleId) {
  return requestFull(`/warehouses/${warehouseId}/obstacles/${encodeURIComponent(obstacleId)}`, {
    method: 'DELETE',
  });
}

// --- Pathfinding (AI Visualisation Panel) ---------------------------------

export function findRoute(warehouseId, { start, goal, heuristic, allowDiagonal, trace }) {
  return request(`/warehouses/${warehouseId}/path`, {
    method: 'POST',
    body: JSON.stringify({ start, goal, heuristic, allowDiagonal, trace }),
  });
}

// --- Simulation --------------------------------------------------------------

export function tickSimulation(warehouseId, deltaSeconds) {
  return request(`/warehouses/${warehouseId}/tick`, {
    method: 'POST',
    body: JSON.stringify({ deltaSeconds }),
  });
}

// --- Logs ------------------------------------------------------------------

export function listLogs(params = {}, options = {}) {
  const query = new URLSearchParams({ limit: '50', ...params }).toString();
  return requestFull(`/logs?${query}`, options);
}

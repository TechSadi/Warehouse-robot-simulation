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

/** Serialises concurrent refresh attempts: a dashboard fires several
 * requests at once, and without this a single expired access token would
 * trigger one refresh per in-flight request - each rotating the refresh
 * token and invalidating the others, which the server's reuse detection
 * would correctly treat as theft and log the user out. */
let refreshInFlight = null;

async function attemptRefresh() {
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

  return fetch(`${API_BASE}${path}`, {
    // Without this the browser sends no cookies to a cross-origin API, so
    // every request would be unauthenticated.
    credentials: 'include',
    ...options,
    headers,
  });
}

async function requestFull(path, options = {}, { retryOn401 = true } = {}) {
  let res = await rawRequest(path, options);

  // A 401 usually just means the short-lived access token lapsed. Try one
  // silent refresh before bothering the user for their password again.
  if (res.status === 401 && retryOn401 && !path.startsWith('/auth/')) {
    const refreshed = await attemptRefresh();
    if (refreshed) {
      res = await rawRequest(path, options);
    } else if (onUnauthenticated) {
      onUnauthenticated();
    }
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    if (res.status === 401 && onUnauthenticated) onUnauthenticated();
    const message = body?.error?.message || `Request failed: ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    error.details = body?.error?.details;
    throw error;
  }

  return body || {};
}

async function request(path, options = {}) {
  const body = await requestFull(path, options);
  return body.data;
}

export { requestFull, request };

export function getHealth() {
  return request('/health');
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
export async function getCurrentUser() {
  try {
    const data = await requestFull('/auth/me');
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

export function listWarehouses(params = {}) {
  const query = new URLSearchParams({ limit: '50', ...params }).toString();
  return requestFull(`/warehouses?${query}`);
}

export function getWarehouse(id) {
  return request(`/warehouses/${id}`);
}

export function deleteWarehouse(id) {
  return requestFull(`/warehouses/${id}`, { method: 'DELETE' });
}

// --- Robots ----------------------------------------------------------------

export function listRobots(warehouseId) {
  return requestFull(`/robots?warehouseId=${warehouseId}&limit=100`);
}

export function spawnRobot(payload) {
  return request('/robots', { method: 'POST', body: JSON.stringify(payload) });
}

export function assignRobotTask(robotId, destination) {
  return request(`/robots/${robotId}/tasks`, { method: 'POST', body: JSON.stringify({ destination }) });
}

// --- Orders ------------------------------------------------------------------

export function listOrders(warehouseId, params = {}) {
  const query = new URLSearchParams({ warehouseId, limit: '100', ...params }).toString();
  return requestFull(`/orders?${query}`);
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

export function listObstacles(warehouseId) {
  return requestFull(`/warehouses/${warehouseId}/obstacles`);
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

export function listLogs(params = {}) {
  const query = new URLSearchParams({ limit: '50', ...params }).toString();
  return requestFull(`/logs?${query}`);
}

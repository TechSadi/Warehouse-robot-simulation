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

async function requestFull(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const message = body?.error?.message || `Request failed: ${res.status}`;
    throw new Error(message);
  }

  return body || {};
}

async function request(path, options = {}) {
  const body = await requestFull(path, options);
  return body.data;
}

export function getHealth() {
  return request('/health');
}

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

const simulationManager = require('./simulationManager');
const orderService = require('./orderService');
const Log = require('../models/Log');
const simulationEvents = require('../events/simulationEvents');

// Last obstacle list broadcast per warehouse, serialized for cheap
// comparison. Obstacles only actually change when one is added/removed
// (already broadcast directly from warehouse.controller.js) or when one
// expires mid-tick (engine.tick() -> dynamicObstacles.tick() handles that
// internally) - so this exists purely to avoid re-emitting an unchanged
// obstacle list on every single tick at 2Hz. See forgetWarehouse below for
// why entries don't just accumulate here forever.
const lastObstacleSnapshot = new Map();

/** Milestone 14: drops a warehouse's cached obstacle snapshot. Without
 * this, `lastObstacleSnapshot` gained one entry for every distinct
 * warehouse ever ticked and never released it, even after that warehouse
 * was deleted or its engine cache was invalidated - a small but real,
 * genuinely unbounded-over-a-server's-lifetime leak (unlike the bounded,
 * per-request growth everything else in this file does). Called alongside
 * simulationManager.invalidate() from warehouse.controller.js, not from
 * simulationManager itself, to avoid a require() cycle between the two
 * modules (simulationManager doesn't know tickRunner exists). */
function forgetWarehouse(warehouseId) {
  lastObstacleSnapshot.delete(String(warehouseId));
}

/**
 * Advances one warehouse's live simulation by `deltaSeconds` and broadcasts
 * the results over simulationEvents (see src/events/simulationEvents.js) so
 * every connected client watching this warehouse sees it in real time -
 * regardless of whether this tick was triggered by the server-side
 * interval loop (src/sockets/tickLoopManager.js) or a manual
 * POST /api/warehouses/:id/tick call. Both paths call this one function so
 * there's a single source of truth for what "advance the simulation" does
 * (this replaces the logic that used to live directly in
 * warehouse.controller.js's `tick` handler).
 *
 * Returns null if the warehouse doesn't exist; otherwise
 * { changed, orderEvents, dispatched }, the same shape the REST endpoint
 * has always returned.
 */
async function runTick(warehouseId, deltaSeconds = 1) {
  const engine = await simulationManager.getEngine(warehouseId);
  const coordinator = await simulationManager.getOrderCoordinator(warehouseId);
  if (!engine || !coordinator) return null;

  const key = String(warehouseId);

  const changed = engine.tick(deltaSeconds);
  await simulationManager.persistRobots(changed);
  if (changed.length > 0) {
    simulationEvents.emit('robots:changed', { warehouseId: key, robots: changed });
  }

  const orderEvents = coordinator.processTick(changed);
  await orderService.processTickEvents(warehouseId, orderEvents);

  const newlyErrored = changed.filter((r) => r.status === 'error');
  await Promise.all(
    newlyErrored.map(async (r) => {
      const message = `Robot ${r.id} entered error state: ${r.errorReason}`;
      await Log.create({ level: 'warn', source: 'robot-engine', message, warehouseId });
      simulationEvents.emit('notification', {
        warehouseId: key,
        level: 'warn',
        message,
        timestamp: new Date().toISOString(),
      });
    })
  );

  // orderService.dispatchPendingOrders emits its own 'orders:changed' when
  // it actually assigns something - see services/orderService.js.
  const dispatched = await orderService.dispatchPendingOrders(warehouseId);

  const obstacles = typeof engine.getObstacles === 'function' ? engine.getObstacles() : [];
  const serialized = JSON.stringify(obstacles);
  if (lastObstacleSnapshot.get(key) !== serialized) {
    lastObstacleSnapshot.set(key, serialized);
    simulationEvents.emit('obstacles:changed', { warehouseId: key, obstacles });
  }

  return { changed, orderEvents, dispatched };
}

module.exports = { runTick, forgetWarehouse };

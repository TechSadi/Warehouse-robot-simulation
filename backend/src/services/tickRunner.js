const simulationManager = require('./simulationManager');
const orderService = require('./orderService');
const warehouseLock = require('./warehouseLock');
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
  warehouseLock.forget(warehouseId);
}

/**
 * The one mechanism that advances simulation time.
 *
 * Every way to move a warehouse forward - `POST /api/warehouses/:id/tick`,
 * the server-owned interval loop (src/sockets/tickLoopManager.js), and any
 * future scheduler - lands here, so "what a tick does" is defined once.
 * What changed in the reliability phase is that it is now also defined to
 * happen *alone*: the body runs inside this warehouse's lock
 * (services/warehouseLock.js), so a tick cannot interleave with another
 * tick, a dispatch, an obstacle change, a robot being created or deleted,
 * or a simulation being started or stopped.
 *
 * It needed to. `engine.tick()` mutates every robot, then this function
 * awaits a Mongo write, then a second await for order events, then a
 * third for dispatch. Each of those is a yield point at which a second
 * caller used to be free to run `engine.tick()` again on a fleet whose
 * previous tick had not been persisted or reconciled yet - producing
 * double movement in one interval, order events attributed to the wrong
 * tick, and robots persisted from a snapshot that was already stale.
 *
 * Returns null if the warehouse doesn't exist; otherwise
 * { changed, orderEvents, dispatched }, the same shape the REST endpoint
 * has always returned.
 */
async function runTick(warehouseId, deltaSeconds = 1) {
  return warehouseLock.runExclusive(warehouseId, () => runTickLocked(warehouseId, deltaSeconds));
}

/**
 * A tick for the automatic loop: skipped outright when the warehouse is
 * already busy, rather than queued behind whatever is running.
 *
 * `setInterval` does not wait for an async callback, so at 2Hz a tick that
 * takes longer than 500ms (a large fleet, a slow write, a replan storm)
 * used to have the next one start on top of it. Queueing them instead
 * would only defer the problem: the backlog drains as a burst of catch-up
 * ticks that fast-forward the simulation. Dropping is the honest option -
 * that interval simply produced no motion.
 *
 * Returns `{ skipped: true }` or `{ skipped: false, value }`.
 */
function runAutoTick(warehouseId, deltaSeconds = 1) {
  return warehouseLock.tryRunExclusive(warehouseId, () => runTickLocked(warehouseId, deltaSeconds));
}

/**
 * The tick body. Assumes the caller already holds this warehouse's lock -
 * it calls `orderService.dispatchPendingOrdersLocked` for exactly that
 * reason, since re-entering the lock from inside it would deadlock.
 */
async function runTickLocked(warehouseId, deltaSeconds) {
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

  // Robots maintenance retrieved this tick, because their battery reached
  // zero away from a charging station - the one fault a robot cannot work
  // its way out of (see RobotEngine._recoverStranded). Reported as loudly
  // as the fault itself: a fleet that quietly repairs itself is a fleet
  // whose operator never finds out their charging stations are in the
  // wrong place.
  const recoveries = typeof engine.takeRecoveries === 'function' ? engine.takeRecoveries() : [];
  await Promise.all(
    recoveries.map(async ({ robotId, from, to }) => {
      const message =
        `Robot ${robotId} was recovered by maintenance from (${from.x}, ${from.y}) ` +
        `to the charging station at (${to.x}, ${to.y}) after its battery ran flat`;
      await Log.create({ level: 'warn', source: 'robot-engine', message, warehouseId });
      simulationEvents.emit('notification', {
        warehouseId: key,
        level: 'warn',
        message,
        timestamp: new Date().toISOString(),
      });
    })
  );

  // orderService.dispatchPendingOrdersLocked emits its own 'orders:changed'
  // when it actually assigns something - see services/orderService.js.
  const dispatched = await orderService.dispatchPendingOrdersLocked(warehouseId);

  const obstacles = typeof engine.getObstacles === 'function' ? engine.getObstacles() : [];
  const serialized = JSON.stringify(obstacles);
  if (lastObstacleSnapshot.get(key) !== serialized) {
    lastObstacleSnapshot.set(key, serialized);
    // The set changes during a tick only when a timed hazard expires, so
    // this write is rare - which is the whole reason the comparison above
    // exists. Persisting here is what stops an expired hazard coming back
    // to life on the next engine load. Already inside the warehouse lock.
    await simulationManager.persistObstacles(warehouseId, engine);
    simulationEvents.emit('obstacles:changed', { warehouseId: key, obstacles });
  }

  return { changed, orderEvents, dispatched };
}

module.exports = { runTick, runAutoTick, forgetWarehouse };

/**
 * Per-warehouse serialized execution.
 *
 * Every operation that reads-then-mutates one warehouse's live simulation
 * has an `await` in the middle of it: `runTick` persists robots and order
 * events between `engine.tick()` and `dispatchPendingOrders`;
 * `dispatchPendingOrders` reads pending orders from Mongo before touching
 * the engine; the obstacle endpoints mutate the engine's obstacle manager
 * directly. Node is single-threaded, but `await` is a yield point - two
 * such operations arriving close together (a REST tick landing while the
 * server-owned interval loop is mid-tick, a dispatch racing the tick that
 * triggered it, an obstacle added while a robot is being replanned around
 * the old obstacle set) interleave freely, and each one assumes it is the
 * only writer.
 *
 * The fix is the simplest one that actually holds: one FIFO queue per
 * warehouse. Warehouses are fully independent - nothing in this simulation
 * spans two of them - so serializing per warehouse costs nothing in
 * throughput while making every operation on a single warehouse atomic
 * with respect to every other.
 *
 * This is deliberately a single-process, in-memory lock. It is correct for
 * the deployment this application actually has (one Node process owning
 * every live engine, exactly like `simulationManager`'s engine cache), and
 * introducing a distributed lock would only be meaningful if the engine
 * state were shared too, which it is not.
 *
 *   Warehouse A          Warehouse B
 *     tick        \        tick
 *     dispatch     |  ->   obstacle update      (A and B run concurrently;
 *     obstacle     |       simulation control    within A, strictly in
 *     start/stop  /                              arrival order)
 */

/**
 * How many operations may be waiting on one warehouse before new ones are
 * rejected outright. A backlog this deep means work is arriving faster
 * than the simulation can absorb it; queueing it anyway converts a burst
 * of requests into unbounded memory growth and ever-staler responses.
 * Rejecting is both cheaper and more honest - the caller finds out.
 */
const MAX_QUEUE_DEPTH = 32;

class WarehouseBusyError extends Error {
  constructor(warehouseId) {
    super(`Warehouse ${warehouseId} has too many simulation operations queued; try again shortly`);
    this.name = 'WarehouseBusyError';
    this.code = 'WAREHOUSE_BUSY';
    // `statusCode` is what middleware/errorHandler.js reads.
    this.statusCode = 503;
  }
}

/** @type {Map<string, {tail: Promise<any>, depth: number}>} */
const chains = new Map();

function entryFor(key) {
  let entry = chains.get(key);
  if (!entry) {
    entry = { tail: Promise.resolve(), depth: 0 };
    chains.set(key, entry);
  }
  return entry;
}

/** True while an operation for this warehouse is running or queued. */
function isBusy(warehouseId) {
  const entry = chains.get(String(warehouseId));
  return Boolean(entry && entry.depth > 0);
}

function queueDepth(warehouseId) {
  const entry = chains.get(String(warehouseId));
  return entry ? entry.depth : 0;
}

/**
 * Runs `fn` with exclusive access to this warehouse's simulation state,
 * after every operation already queued for it has finished. Resolves (or
 * rejects) with whatever `fn` does; a rejection releases the lock and does
 * not poison the queue for the operations behind it.
 */
function runExclusive(warehouseId, fn) {
  const key = String(warehouseId);
  const entry = entryFor(key);

  if (entry.depth >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new WarehouseBusyError(key));
  }

  entry.depth += 1;
  // Chain off `tail` regardless of how the previous operation settled, so
  // one failed tick cannot wedge the warehouse permanently.
  const result = entry.tail.then(fn, fn);
  entry.tail = result.then(
    () => undefined,
    () => undefined
  );
  return result.finally(() => {
    entry.depth -= 1;
    // Nothing queued and nothing running - drop the entry rather than
    // keeping one per warehouse ever touched for the life of the process.
    if (entry.depth === 0 && chains.get(key) === entry) chains.delete(key);
  });
}

/**
 * Like `runExclusive`, but gives up immediately instead of queueing when
 * the warehouse is already busy. This is what the automatic tick loop uses:
 * a tick that arrives while the previous one is still running should be
 * *dropped*, not stacked. Queueing them would let a slow tick (a large
 * fleet, a slow Mongo write) build a backlog that then replays as a burst
 * of catch-up ticks, advancing the simulation in a way no one asked for.
 * Skipping simply means that interval produced no motion, which is the
 * honest outcome.
 *
 * Returns `{ skipped: true }` when it did not run, or
 * `{ skipped: false, value }` when it did.
 */
async function tryRunExclusive(warehouseId, fn) {
  if (isBusy(warehouseId)) return { skipped: true };
  const value = await runExclusive(warehouseId, fn);
  return { skipped: false, value };
}

/** Drops a warehouse's queue bookkeeping. Operations already in flight are
 * unaffected - this only forgets the (empty) chain entry, e.g. after the
 * warehouse is deleted. */
function forget(warehouseId) {
  const key = String(warehouseId);
  const entry = chains.get(key);
  if (entry && entry.depth === 0) chains.delete(key);
}

/** Test-only: forgets every chain. Never call this from application code -
 * it does not cancel in-flight work. */
function _reset() {
  chains.clear();
}

module.exports = {
  runExclusive,
  tryRunExclusive,
  isBusy,
  queueDepth,
  forget,
  WarehouseBusyError,
  MAX_QUEUE_DEPTH,
  _reset,
};

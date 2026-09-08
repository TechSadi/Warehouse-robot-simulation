const { runAutoTick } = require('../services/tickRunner');

const DEFAULT_TICK_INTERVAL_MS = 500;

function room(warehouseId) {
  return `warehouse:${warehouseId}`;
}

/**
 * Owns at most one server-side tick interval per warehouse, shared by
 * every connected client watching that warehouse. This is Milestone 11's
 * real-time replacement for Milestone 10's client-driven `setInterval`
 * that called the REST tick endpoint directly - the simulation now
 * advances on the server regardless of which client asked for it to start,
 * and keeps running for everyone else watching even if that original
 * client disconnects. It stops itself once nobody is left watching (see
 * stopIfIdle), rather than ticking forever for an empty room.
 *
 * Start/stop semantics, stated once (see docs/SIMULATION_ARCHITECTURE.md):
 *
 *  - Starting a warehouse that is already running is a no-op for the loop
 *    (one interval per warehouse, never one per client) but is *not*
 *    silent: `start()` reports whether it actually started, so the caller
 *    can confirm the current state back to the requester. A second start
 *    never changes the running loop's tick delta - the first start's
 *    cadence is the one in effect, and telling the second caller "running"
 *    is truthful about what it will observe.
 *  - Stopping a warehouse that is not running is likewise a reported
 *    no-op, not an error: "stopped" is the state the caller asked for and
 *    the state they get.
 *  - Ticks are dropped, never queued, when the previous one is still in
 *    flight (see `runAutoTick`), so a slow tick cannot build a backlog
 *    that later replays as a burst.
 *  - A failed tick is logged and counted; the interval survives it and
 *    tries again next time. Nothing about the failure is left holding the
 *    warehouse lock - `runExclusive` releases on rejection.
 *  - Manual ticks (`POST /api/warehouses/:id/tick`) and this loop share
 *    the same lock, so a manual tick during automatic ticking is applied
 *    strictly between two automatic ones, never on top of one.
 */
class TickLoopManager {
  constructor(tickIntervalMs = DEFAULT_TICK_INTERVAL_MS) {
    this.tickIntervalMs = tickIntervalMs;
    /** @type {Map<string, {interval: NodeJS.Timeout, deltaSeconds: number, startedAt: number, ticks: number, skipped: number, failures: number, lastError: string|null}>} */
    this.loops = new Map();
  }

  isRunning(warehouseId) {
    return this.loops.has(String(warehouseId));
  }

  /** The current loop state for a warehouse - what a joining or
   * reconnecting client needs in order to render Start/Stop correctly
   * without guessing. */
  status(warehouseId) {
    const key = String(warehouseId);
    const loop = this.loops.get(key);
    if (!loop) return { warehouseId: key, running: false };
    return {
      warehouseId: key,
      running: true,
      deltaSeconds: loop.deltaSeconds,
      startedAt: new Date(loop.startedAt).toISOString(),
      ticks: loop.ticks,
      skippedTicks: loop.skipped,
      failedTicks: loop.failures,
    };
  }

  /** Returns `{ started, status }` - `started: false` means it was already
   * running and this call changed nothing. */
  start(io, warehouseId, deltaSeconds) {
    const key = String(warehouseId);
    if (this.loops.has(key)) return { started: false, status: this.status(key) };

    const effectiveDelta = deltaSeconds || this.tickIntervalMs / 1000;
    const loop = {
      interval: null,
      deltaSeconds: effectiveDelta,
      startedAt: Date.now(),
      ticks: 0,
      skipped: 0,
      failures: 0,
      lastError: null,
    };

    loop.interval = setInterval(() => {
      runAutoTick(warehouseId, effectiveDelta)
        .then(({ skipped }) => {
          if (skipped) loop.skipped += 1;
          else loop.ticks += 1;
        })
        .catch((err) => {
          // A single failed tick (e.g. the warehouse was deleted mid-run)
          // must not crash the interval or the process - count it, log it,
          // and let the next tick try again; if the warehouse is really
          // gone, runTick just keeps returning null harmlessly.
          loop.failures += 1;
          loop.lastError = err.message;
          console.error(`[tickLoop] tick failed for warehouse ${key}:`, err.message);
        });
    }, this.tickIntervalMs);

    this.loops.set(key, loop);
    io.to(room(key)).emit('simulation:status', this.status(key));
    return { started: true, status: this.status(key) };
  }

  /** Returns `{ stopped, status }` - `stopped: false` means it was not
   * running and this call changed nothing. */
  stop(io, warehouseId) {
    const key = String(warehouseId);
    const loop = this.loops.get(key);
    if (!loop) return { stopped: false, status: this.status(key) };
    clearInterval(loop.interval);
    this.loops.delete(key);
    io.to(room(key)).emit('simulation:status', { warehouseId: key, running: false });
    return { stopped: true, status: this.status(key) };
  }

  /** Stops the loop if no socket remains in the warehouse's room. Safe to
   * call whether or not a loop is currently running, and whether or not
   * the room still exists - call this after any leave/disconnect. */
  stopIfIdle(io, warehouseId) {
    const key = String(warehouseId);
    if (!this.loops.has(key)) return;
    const occupants = io.sockets.adapter.rooms.get(room(key));
    if (!occupants || occupants.size === 0) this.stop(io, warehouseId);
  }

  /** Clears every running interval - called on server shutdown so nothing
   * keeps the process (or a test) alive after it should have exited. */
  stopAll() {
    for (const loop of this.loops.values()) clearInterval(loop.interval);
    this.loops.clear();
  }
}

module.exports = { TickLoopManager, room };

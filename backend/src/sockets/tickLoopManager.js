const { runTick } = require('../services/tickRunner');

const DEFAULT_TICK_INTERVAL_MS = 500;

function room(warehouseId) {
  return `warehouse:${warehouseId}`;
}

/**
 * Owns at most one server-side tick interval per warehouse, shared by
 * every connected client watching that warehouse. This is Milestone 11's
 * real-time replacement for Milestone 10's client-driven `setInterval`
 * that called the REST tick endpoint directly (see the "honest
 * architectural note" in the README's Milestone 10 section) - the
 * simulation now advances on the server regardless of which client asked
 * for it to start, and keeps running for everyone else watching even if
 * that original client disconnects. It stops itself once nobody is left
 * watching (see stopIfIdle), rather than ticking forever in the
 * background for an empty room.
 *
 * Starting a warehouse that's already running is a no-op (one interval
 * per warehouse, not one per client); stopping it stops it for everyone.
 */
class TickLoopManager {
  constructor(tickIntervalMs = DEFAULT_TICK_INTERVAL_MS) {
    this.tickIntervalMs = tickIntervalMs;
    /** @type {Map<string, NodeJS.Timeout>} */
    this.intervals = new Map();
  }

  isRunning(warehouseId) {
    return this.intervals.has(String(warehouseId));
  }

  start(io, warehouseId, deltaSeconds) {
    const key = String(warehouseId);
    if (this.intervals.has(key)) return; // already running - starting again is a no-op

    const effectiveDelta = deltaSeconds || this.tickIntervalMs / 1000;
    const interval = setInterval(() => {
      runTick(warehouseId, effectiveDelta).catch((err) => {
        // A single failed tick (e.g. the warehouse was deleted mid-run)
        // shouldn't crash the interval or the process - log and let the
        // next tick try again; if the warehouse is really gone, runTick
        // just keeps returning null harmlessly.
        console.error(`[tickLoop] tick failed for warehouse ${key}:`, err.message);
      });
    }, this.tickIntervalMs);

    this.intervals.set(key, interval);
    io.to(room(key)).emit('simulation:status', { warehouseId: key, running: true });
  }

  stop(io, warehouseId) {
    const key = String(warehouseId);
    const interval = this.intervals.get(key);
    if (!interval) return;
    clearInterval(interval);
    this.intervals.delete(key);
    io.to(room(key)).emit('simulation:status', { warehouseId: key, running: false });
  }

  /** Stops the loop if no socket remains in the warehouse's room. Safe to
   * call whether or not a loop is currently running, and whether or not
   * the room still exists - call this after any leave/disconnect. */
  stopIfIdle(io, warehouseId) {
    const key = String(warehouseId);
    if (!this.intervals.has(key)) return;
    const occupants = io.sockets.adapter.rooms.get(room(key));
    if (!occupants || occupants.size === 0) this.stop(io, warehouseId);
  }

  /** Clears every running interval - called on server shutdown so nothing
   * keeps the process (or a test) alive after it should have exited. */
  stopAll() {
    for (const interval of this.intervals.values()) clearInterval(interval);
    this.intervals.clear();
  }
}

module.exports = { TickLoopManager, room };

const { runAutoTick } = require('../services/tickRunner');
const simulationManager = require('../services/simulationManager');
const instanceLease = require('../services/instanceLease');
const env = require('../config/env');

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
 * client disconnects.
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
 *    that later replays as a burst. What a dropped tick no longer does is
 *    lose the time it covered - see "Simulation time" below.
 *  - A failed tick is logged and counted; the interval survives it and
 *    tries again next time. Nothing about the failure is left holding the
 *    warehouse lock - `runExclusive` releases on rejection.
 *  - Manual ticks (`POST /api/warehouses/:id/tick`) and this loop share
 *    the same lock, so a manual tick during automatic ticking is applied
 *    strictly between two automatic ones, never on top of one.
 *
 * **Simulation time.** A tick used to advance the world by a fixed
 * `deltaSeconds` regardless of how long had actually passed, so a
 * simulation drifted behind wall-clock time whenever the host was busy:
 * every dropped tick, every interval that fired late, and every slow tick
 * silently vanished from the simulation's clock. The loop now measures the
 * elapsed time since the last applied tick and advances by that instead,
 * capped at `maxTickDeltaSeconds`. Three consequences worth stating:
 * dropped ticks no longer lose their time (the next one absorbs it), a
 * lagging server produces a *coarser* simulation rather than a slower one,
 * and time beyond the cap is genuinely lost - which is deliberate, because
 * the alternative to a cap is a fleet that teleports across the warehouse
 * after a long pause. What is lost is counted (`laggedSeconds`) rather
 * than hidden.
 *
 * **Watchers.** A loop normally stops once the last client leaves the
 * warehouse's room - a simulation is a thing being watched, not a
 * background job. `simulation:start` with `background: true` opts out of
 * that for the cases where it genuinely is one (a long soak, a demo left
 * running, a fleet under observation from somewhere other than a browser
 * tab). Unattended work still gets a ceiling: `maxBackgroundSeconds`, after
 * which the loop stops itself, because a forgotten tab must not be able to
 * tick a warehouse for the life of the process.
 *
 * **Instances.** Before each tick the loop confirms this process still
 * holds the warehouse's lease (services/instanceLease.js). A second
 * backend instance running against the same database therefore declines to
 * advance a warehouse the first one is already advancing, rather than
 * running a second simulation of it and writing over the first. Ticks
 * skipped for that reason are counted separately and reported, so a
 * warehouse that is "running but not moving" explains itself.
 */
class TickLoopManager {
  constructor(tickIntervalMs = DEFAULT_TICK_INTERVAL_MS) {
    this.tickIntervalMs = tickIntervalMs;
    /** @type {Map<string, any>} */
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
      background: loop.background,
      // Simulated seconds actually applied, and the elapsed seconds that
      // exceeded the per-tick cap and so were dropped. Together these say
      // how far the simulation is from the wall clock, which is otherwise
      // invisible.
      simulatedSeconds: Math.round(loop.simulatedSeconds * 100) / 100,
      laggedSeconds: Math.round(loop.laggedSeconds * 100) / 100,
      // Non-zero only when another backend instance holds this
      // warehouse's lease - see services/instanceLease.js.
      blockedTicks: loop.blocked,
      blockedBy: loop.blockedBy,
    };
  }

  /**
   * Returns `{ started, status }` - `started: false` means it was already
   * running and this call changed nothing.
   *
   * @param {any} io
   * @param {string} warehouseId
   * @param {number} [deltaSeconds] nominal step; the actual step is
   *   measured elapsed time, and this is the fallback for the first tick
   *   and the ceiling reported to clients.
   * @param {{background?: boolean}} [options]
   */
  start(io, warehouseId, deltaSeconds, options = {}) {
    const key = String(warehouseId);
    if (this.loops.has(key)) return { started: false, status: this.status(key) };

    const nominalDelta = deltaSeconds || this.tickIntervalMs / 1000;
    const loop = {
      interval: null,
      deltaSeconds: nominalDelta,
      startedAt: Date.now(),
      lastTickAt: Date.now(),
      ticks: 0,
      skipped: 0,
      failures: 0,
      blocked: 0,
      blockedBy: null,
      simulatedSeconds: 0,
      laggedSeconds: 0,
      background: Boolean(options.background),
      lastError: null,
    };

    // Pinned for as long as it is running: the engine cache evicts idle
    // warehouses (services/simulationManager.js), and evicting one
    // mid-simulation would reload it a moment later and requeue every
    // in-flight order it was working.
    simulationManager.pin(key);

    loop.interval = setInterval(() => {
      this._runOnce(io, key, loop).catch((err) => {
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

  /** One interval firing: lease check, elapsed-time measurement, tick. */
  async _runOnce(io, key, loop) {
    // A background simulation is unattended by definition, so its ceiling
    // is checked here rather than relying on anyone to notice.
    if (loop.background && Date.now() - loop.startedAt > env.simulation.maxBackgroundSeconds * 1000) {
      console.log(`[tickLoop] background simulation for warehouse ${key} reached its time limit; stopping`);
      this.stop(io, key);
      return;
    }

    const lease = await instanceLease.ensure(key);
    if (!lease.held) {
      loop.blocked += 1;
      if (loop.blockedBy !== lease.heldBy) {
        loop.blockedBy = lease.heldBy;
        console.warn(`[tickLoop] warehouse ${key} is being simulated by ${lease.heldBy}; not ticking here`);
        io.to(room(key)).emit('simulation:status', this.status(key));
      }
      // The clock is not this instance's to advance, so do not let elapsed
      // time accumulate against a tick it will never apply.
      loop.lastTickAt = Date.now();
      return;
    }
    if (loop.blockedBy) {
      loop.blockedBy = null;
      io.to(room(key)).emit('simulation:status', this.status(key));
    }

    const now = Date.now();
    const elapsed = (now - loop.lastTickAt) / 1000;
    const delta = Math.min(elapsed, env.simulation.maxTickDeltaSeconds);

    const { skipped } = await runAutoTick(key, delta);
    if (skipped) {
      // Deliberately does *not* advance lastTickAt: the time this interval
      // covered was not simulated, so it belongs to the next tick that
      // actually runs. That is the difference between "dropped, and the
      // simulation runs slow" and "dropped, and the simulation catches up
      // within the cap".
      loop.skipped += 1;
      return;
    }

    loop.lastTickAt = now;
    loop.ticks += 1;
    loop.simulatedSeconds += delta;
    loop.laggedSeconds += Math.max(0, elapsed - delta);
  }

  /** Returns `{ stopped, status }` - `stopped: false` means it was not
   * running and this call changed nothing. */
  stop(io, warehouseId) {
    const key = String(warehouseId);
    const loop = this.loops.get(key);
    if (!loop) return { stopped: false, status: this.status(key) };
    clearInterval(loop.interval);
    this.loops.delete(key);
    simulationManager.unpin(key);
    // Best-effort and deliberately not awaited: stopping must stay
    // synchronous for its callers (a socket handler, a warehouse delete),
    // and the lease's TTL is what actually guarantees release. This only
    // makes handover to another instance fast in the common case.
    Promise.resolve(instanceLease.release(key)).catch(() => {});
    io.to(room(key)).emit('simulation:status', { warehouseId: key, running: false });
    return { stopped: true, status: this.status(key) };
  }

  /** Stops the loop if no socket remains in the warehouse's room. Safe to
   * call whether or not a loop is currently running, and whether or not
   * the room still exists - call this after any leave/disconnect. A loop
   * started with `background: true` is exempt: it was explicitly asked to
   * outlive its watchers. */
  stopIfIdle(io, warehouseId) {
    const key = String(warehouseId);
    const loop = this.loops.get(key);
    if (!loop) return;
    if (loop.background) return;
    const occupants = io.sockets.adapter.rooms.get(room(key));
    if (!occupants || occupants.size === 0) this.stop(io, warehouseId);
  }

  /** Clears every running interval - called on server shutdown so nothing
   * keeps the process (or a test) alive after it should have exited. */
  stopAll() {
    for (const [key, loop] of this.loops) {
      clearInterval(loop.interval);
      simulationManager.unpin(key);
    }
    this.loops.clear();
    // Hands every warehouse this process was running back immediately,
    // rather than leaving each one unavailable to a restarted instance for
    // up to a lease TTL.
    return Promise.resolve(instanceLease.releaseAll()).catch(() => {});
  }
}

module.exports = { TickLoopManager, room };

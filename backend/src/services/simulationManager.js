const Warehouse = require('../models/Warehouse');
const Robot = require('../models/Robot');
const Order = require('../models/Order');
const { RobotEngine, STATUSES } = require('../engine/robots/robotEngine');
const { OrderCoordinator } = require('../engine/orders/orderCoordinator');
const { warehouseToGrid } = require('../engine/grid/warehouseGrid');
const { IN_FLIGHT_STATUSES } = require('../domain/orderLifecycle');

/**
 * The whole cell a persisted position corresponds to.
 *
 * A moving robot's position is interpolated *between* cells - that is what
 * makes the live view smooth - and whatever fraction it happened to be at
 * when the process stopped is what Mongo holds. The engine is a grid
 * simulation, though: every robot occupies one cell, collision checks
 * compare cells, and A* plans between cells. Seeding an engine from a
 * fractional position used to leave the robot out of the simulation
 * entirely (the spawn was rejected), so a restart mid-move quietly lost
 * robots. Rounding is the right resolution rather than a lossy one: the
 * in-flight move is not resumed either way (its path lived only in
 * memory), so the robot resumes at rest, in the cell it was nearest.
 */
function toCell(position) {
  return { x: Math.round(position?.x ?? 0), y: Math.round(position?.y ?? 0) };
}

/**
 * Owns the *runtime* half of the simulation - see
 * docs/SIMULATION_ARCHITECTURE.md for the full ownership table. In short:
 *
 *   MongoDB is authoritative for   identity and configuration (which
 *                                  robots/orders/warehouses exist, their
 *                                  names, speeds, layouts, and the order
 *                                  lifecycle status)
 *   The RobotEngine is authoritative for
 *                                  live physical state while the process
 *                                  is up (exact position, rotation,
 *                                  battery, robot status, task queue,
 *                                  dynamic obstacles)
 *
 * Mongo therefore lags the engine by at most one tick, and is written from
 * it - never the other way round while an engine is loaded. The one moment
 * the flow reverses is engine *construction*, which seeds runtime state
 * from the last persisted snapshot; that is also the moment any
 * disagreement between the two has to be resolved, which is what
 * `reconcileWarehouse` below does.
 */
class SimulationManager {
  constructor() {
    /**
     * Engines are cached as *promises*, not as resolved instances.
     *
     * `getEngine` has an `await` between "is it cached?" and "cache it",
     * so with a plain instance cache two callers arriving together (the
     * REST tick endpoint and the interval loop, or `getEngine` and
     * `getOrderCoordinator` inside one `runTick`) would both miss, both
     * build a `RobotEngine`, and both write it to the map. The loser's
     * engine kept running as a detached second simulation of the same
     * warehouse - robots moving on an engine nothing would ever tick
     * again, and an OrderCoordinator bound to whichever instance happened
     * to win. Caching the in-flight promise makes the first caller the
     * only builder and every concurrent caller a subscriber to it.
     * @type {Map<string, Promise<RobotEngine|null>>}
     */
    this.engines = new Map();
    /** @type {Map<string, OrderCoordinator>} */
    this.orderCoordinators = new Map();
    /** @type {Map<string, {cursor: number, completedCounts: Map<string, number>}>} */
    this.schedulerStates = new Map();
  }

  /**
   * Returns the live engine for a warehouse, creating and seeding it from
   * MongoDB on first use. Returns null if the warehouse does not exist.
   *
   * Deterministic by construction: whatever the interleaving of callers,
   * exactly one engine is ever built per warehouse per cache generation,
   * and it is seeded from one read of the warehouse and one read of its
   * robots.
   */
  async getEngine(warehouseId) {
    const key = String(warehouseId);
    const cached = this.engines.get(key);
    if (cached) return cached;

    const pending = this._loadEngine(warehouseId).catch((err) => {
      // A failed load must not stay cached, or the warehouse is broken for
      // the remaining life of the process.
      if (this.engines.get(key) === pending) this.engines.delete(key);
      throw err;
    });
    this.engines.set(key, pending);

    const engine = await pending;
    // A warehouse that does not exist is not cached either - one may be
    // created under that id a moment later.
    if (!engine && this.engines.get(key) === pending) this.engines.delete(key);
    return engine;
  }

  /**
   * Builds one engine from persisted state and reconciles the two halves
   * of the system, so MongoDB is not left describing a simulation that is
   * no longer running.
   */
  async _loadEngine(warehouseId) {
    const warehouse = await Warehouse.findById(warehouseId);
    if (!warehouse) return null;

    const grid = warehouseToGrid(warehouse);
    const engine = new RobotEngine(grid);
    const robots = await Robot.find({ warehouseId });

    /** Robots whose persisted state could not be reproduced in the engine. */
    const unloadable = [];
    /** Robots whose persisted status disagrees with how they loaded. */
    const corrections = [];

    // Sorted by id so two loads of the same data always resolve cell
    // contention (two robots persisted on one cell) the same way, rather
    // than however Mongo happened to order the result set.
    const ordered = [...robots].sort((a, b) => String(a._id).localeCompare(String(b._id)));

    for (const doc of ordered) {
      const id = String(doc._id);
      const cell = toCell(doc.position);
      let snapshot;
      try {
        snapshot = engine.spawnRobot({
          id,
          name: doc.name,
          position: cell,
          speed: doc.speed,
          battery: doc.battery,
        });
      } catch (err) {
        // The saved position is no longer usable - the layout changed
        // under it, or another robot is saved on the same cell. It stays
        // out of the live engine until it is repositioned, and Mongo is
        // told so rather than continuing to advertise a healthy robot the
        // simulation cannot see.
        unloadable.push({ id, reason: err.message });
        continue;
      }

      // Restore the states worth resuming. A robot that was `moving` is
      // not resumed: its path lived only in memory and the world may have
      // changed underneath it, so it comes back idle at its last persisted
      // cell and is re-dispatched normally. A robot that was `error` stays
      // broken - a restart is not a repair.
      if (doc.status === STATUSES.CHARGING && grid.isCharging(doc.position.x, doc.position.y)) {
        snapshot = engine.startCharging(id);
      } else if (doc.status === STATUSES.ERROR) {
        snapshot = engine.markBroken(id, doc.errorReason || 'Robot was in an error state before restart');
      }

      // `|| IDLE` mirrors the schema default: a document with no stored
      // status is not a disagreement to write back, it is a robot that has
      // never been ticked. A snapped position is a disagreement too: the
      // document says the robot is between two cells and the engine now
      // says which cell it is in.
      const statusChanged = snapshot.status !== (doc.status || STATUSES.IDLE);
      const positionChanged = cell.x !== doc.position.x || cell.y !== doc.position.y;
      if (statusChanged || positionChanged) corrections.push(snapshot);
    }

    await this.reconcileWarehouse(warehouseId, { unloadable, corrections });
    return engine;
  }

  /**
   * Makes MongoDB agree with the engine that was just built.
   *
   * Two classes of stale state are fixed here:
   *
   *  1. Robots persisted as `moving`/`charging` that came back idle, or
   *     that could not be loaded at all. Without this, a crash mid-
   *     simulation left a fleet that reads as busy forever in every list
   *     endpoint and every statistic derived from one, while nothing was
   *     actually moving.
   *
   *  2. Orders left in an in-flight state. Their progress was being driven
   *     by the OrderCoordinator's in-memory assignment map, which did not
   *     survive; the robot that was carrying them is idle again, and the
   *     dispatcher only ever looks at `pending`. They were therefore
   *     stranded permanently - neither delivered nor dispatchable. They are
   *     released back to `pending` (see the release edges in
   *     domain/orderLifecycle.js) so a robot picks them up again.
   *
   * Failures here are logged, never thrown: recovery bookkeeping must not
   * be able to stop a warehouse from loading.
   */
  async reconcileWarehouse(warehouseId, { unloadable = [], corrections = [] } = {}) {
    const summary = { robotsCorrected: 0, robotsUnloadable: unloadable.length, ordersReleased: 0 };

    try {
      const robotWrites = [
        ...corrections.map((snapshot) => ({
          updateOne: {
            filter: { _id: snapshot.id },
            update: {
              status: snapshot.status,
              battery: snapshot.battery,
              position: snapshot.position,
              errorReason: snapshot.errorReason,
            },
          },
        })),
        ...unloadable.map(({ id, reason }) => ({
          updateOne: {
            filter: { _id: id },
            update: { status: STATUSES.ERROR, errorReason: `Not loaded into the simulation: ${reason}` },
          },
        })),
      ];

      if (robotWrites.length > 0) {
        await Robot.bulkWrite(robotWrites, { ordered: false });
        summary.robotsCorrected = corrections.length;
      }
    } catch (err) {
      console.error(`[simulation] robot reconciliation failed for warehouse ${warehouseId}:`, err.message);
    }

    try {
      const released = await Order.updateMany(
        { warehouseId, status: { $in: IN_FLIGHT_STATUSES } },
        { $set: { status: 'pending', assignedRobot: null, assignedAt: null, pickedUpAt: null } }
      );
      summary.ordersReleased = released?.modifiedCount ?? 0;
    } catch (err) {
      console.error(`[simulation] order reconciliation failed for warehouse ${warehouseId}:`, err.message);
    }

    if (summary.robotsCorrected || summary.robotsUnloadable || summary.ordersReleased) {
      console.warn(
        `[simulation] recovered warehouse ${warehouseId}: ` +
          `${summary.robotsCorrected} robot status correction(s), ` +
          `${summary.robotsUnloadable} robot(s) not loadable, ` +
          `${summary.ordersReleased} in-flight order(s) released to pending`
      );
    }
    return summary;
  }

  /** Drops the cached engine for a warehouse, so the next getEngine() call
   * reloads fresh from MongoDB (e.g. after the layout itself changes).
   * Everything runtime-only goes with it - dynamic obstacles, task queues,
   * and the coordinator's order assignments - which is why the next load
   * releases in-flight orders back to `pending` rather than leaving them
   * pointing at an assignment that no longer exists. */
  invalidate(warehouseId) {
    const key = String(warehouseId);
    this.engines.delete(key);
    this.orderCoordinators.delete(key);
    this.schedulerStates.delete(key);
  }

  /** True if this warehouse currently has a live engine in memory. Lets
   * callers distinguish "nothing is loaded" from "loaded and empty"
   * without forcing a load as a side effect of asking. */
  hasEngine(warehouseId) {
    return this.engines.has(String(warehouseId));
  }

  /**
   * If a warehouse's engine is already cached, adds a newly-created robot
   * to it immediately - so a robot spawned via POST /robots while a
   * simulation is already running can be assigned tasks and moved right
   * away, with no restart or layout edit needed.
   *
   * Returns the engine snapshot on success, or null when there was no
   * engine to add it to (the next load will pick it up from Mongo) or the
   * engine refused the placement. Callers must run this inside the
   * warehouse lock: spawning into an engine that is mid-tick would insert
   * a robot into a fleet that tick has already iterated past.
   */
  async addRobotToCachedEngine(warehouseId, robotDoc) {
    const key = String(warehouseId);
    if (!this.engines.has(key)) return null;
    const engine = await this.engines.get(key);
    if (!engine) return null;
    try {
      return engine.spawnRobot({
        id: String(robotDoc._id),
        name: robotDoc.name,
        position: { x: robotDoc.position.x, y: robotDoc.position.y },
        speed: robotDoc.speed,
        battery: robotDoc.battery,
      });
    } catch {
      return null;
    }
  }

  /**
   * Removes a deleted robot from the live engine and from the order
   * coordinator.
   *
   * Without this, deleting a robot removed only its MongoDB document. The
   * cached engine went on ticking a robot that no longer existed: still
   * consuming its path, still occupying (and so blocking) cells for every
   * other robot, still broadcast to clients as a live robot, and - if it
   * was mid-order - still holding a coordinator assignment that pinned
   * that order in an in-flight state forever, because the event that would
   * have advanced it could only come from a robot the fleet no longer had.
   *
   * Returns the ids of any orders that robot was working, so the caller can
   * release them back to the dispatchable pool.
   */
  async removeRobotFromCachedEngine(warehouseId, robotId) {
    const key = String(warehouseId);
    const id = String(robotId);
    const releasedOrderIds = [];

    const coordinator = this.orderCoordinators.get(key);
    if (coordinator) {
      const assignment = coordinator.getAssignment(id);
      if (assignment) releasedOrderIds.push(assignment.orderId);
      coordinator.releaseRobot(id);
    }

    if (this.engines.has(key)) {
      const engine = await this.engines.get(key);
      if (engine) engine.removeRobot(id);
    }

    this.schedulerStates.get(key)?.completedCounts.delete(id);
    return releasedOrderIds;
  }

  /** Returns the persistent scheduling state for a warehouse (round-robin
   * cursor, per-robot completed-order counts), creating it on first use.
   * Does not require the warehouse/engine to exist yet - it is plain
   * in-memory bookkeeping, not tied to Mongo. */
  getSchedulerState(warehouseId) {
    const key = String(warehouseId);
    if (!this.schedulerStates.has(key)) {
      this.schedulerStates.set(key, { cursor: 0, completedCounts: new Map() });
    }
    return this.schedulerStates.get(key);
  }

  /** Returns the live OrderCoordinator for a warehouse, tied to that
   * warehouse's engine instance. Returns null if the warehouse (and so the
   * engine) does not exist. */
  async getOrderCoordinator(warehouseId) {
    const key = String(warehouseId);
    const engine = await this.getEngine(warehouseId);
    if (!engine) return null;

    // Re-checked *after* awaiting the engine, and validated against it: a
    // coordinator cached against a previous engine generation would be
    // driving a fleet that is no longer the live one.
    const cached = this.orderCoordinators.get(key);
    if (cached && cached.engine === engine) return cached;

    const coordinator = new OrderCoordinator(engine);
    this.orderCoordinators.set(key, coordinator);
    return coordinator;
  }

  /** Persists a robot snapshot's physical fields back to MongoDB. Task
   * queue/path stay in-memory only - see the comment on Robot.taskQueue.
   * For a single robot changing outside a tick (a manual assign/charge/
   * clear-error/mark-broken action) - see persistRobots below for the
   * per-tick, many-robots-at-once case this does not cover well. */
  async persistRobot(robotId, snapshot) {
    await Robot.findByIdAndUpdate(robotId, {
      position: snapshot.position,
      rotation: snapshot.rotation,
      battery: snapshot.battery,
      status: snapshot.status,
      errorReason: snapshot.errorReason,
    });
  }

  /**
   * Milestone 14: persists every changed robot snapshot in a single round
   * trip via bulkWrite, instead of one findByIdAndUpdate per robot. This is
   * what tickRunner calls after every tick - at the milestone's target of
   * 50 simultaneous robots, most of them moving on most ticks, that used to
   * mean up to 50 separate write operations every 500ms; it is now one.
   * `ordered: false` is safe here because engine.tick() only ever produces
   * at most one snapshot per robot per tick (see robotEngine.js), so this
   * array can never contain two operations targeting the same document -
   * there is nothing for write order to matter for.
   *
   * These are blind writes with no optimistic-concurrency guard, and that
   * is deliberate: while an engine is loaded it is the sole authority for
   * physical state, and every write to it is serialized by the warehouse
   * lock (services/warehouseLock.js). There is no second writer to lose a
   * race with - the REST API cannot write these fields at all (see the DTO
   * in controllers/robot.controller.js).
   */
  async persistRobots(snapshots) {
    if (!snapshots || snapshots.length === 0) return;
    await Robot.bulkWrite(
      snapshots.map((snapshot) => ({
        updateOne: {
          filter: { _id: snapshot.id },
          update: {
            position: snapshot.position,
            rotation: snapshot.rotation,
            battery: snapshot.battery,
            status: snapshot.status,
            errorReason: snapshot.errorReason,
          },
        },
      })),
      { ordered: false }
    );
  }
}

// One process, one simulation state per warehouse - a singleton is the
// simplest correct thing here, same as a typical DB connection pool.
module.exports = new SimulationManager();

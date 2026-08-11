const Warehouse = require('../models/Warehouse');
const Robot = require('../models/Robot');
const { RobotEngine } = require('../engine/robots/robotEngine');
const { OrderCoordinator } = require('../engine/orders/orderCoordinator');
const { warehouseToGrid } = require('../engine/grid/warehouseGrid');

class SimulationManager {
  constructor() {
    /** @type {Map<string, RobotEngine>} */
    this.engines = new Map();
    /** @type {Map<string, OrderCoordinator>} */
    this.orderCoordinators = new Map();
    /** @type {Map<string, {cursor: number, completedCounts: Map<string, number>}>} */
    this.schedulerStates = new Map();
  }

  /**
   * Returns the live engine for a warehouse, creating and seeding it from
   * MongoDB on first use. Returns null if the warehouse doesn't exist.
   * Robots are loaded at rest (idle, at their last saved position) - any
   * in-flight path from before a server restart isn't replayed, which is
   * an intentional simplification for now.
   */
  async getEngine(warehouseId) {
    const key = String(warehouseId);
    if (this.engines.has(key)) return this.engines.get(key);

    const warehouse = await Warehouse.findById(warehouseId);
    if (!warehouse) return null;

    const engine = new RobotEngine(warehouseToGrid(warehouse));
    const robots = await Robot.find({ warehouseId });
    for (const doc of robots) {
      try {
        engine.spawnRobot({
          id: doc._id.toString(),
          name: doc.name,
          position: { x: doc.position.x, y: doc.position.y },
          speed: doc.speed,
          battery: doc.battery,
        });
      } catch {
        // The saved position is no longer walkable (e.g. the layout
        // changed since this robot was last placed) - skip it rather than
        // failing the whole warehouse load. It stays absent from the live
        // engine until manually repositioned.
      }
    }

    this.engines.set(key, engine);
    return engine;
  }

  /** Drops the cached engine for a warehouse, so the next getEngine() call
   * reloads fresh from MongoDB (e.g. after the layout itself changes). */
  invalidate(warehouseId) {
    const key = String(warehouseId);
    this.engines.delete(key);
    this.orderCoordinators.delete(key);
    this.schedulerStates.delete(key);
  }

  /** Returns the persistent scheduling state for a warehouse (round-robin
   * cursor, per-robot completed-order counts), creating it on first use.
   * Doesn't require the warehouse/engine to exist yet - it's plain
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
   * engine) doesn't exist. */
  async getOrderCoordinator(warehouseId) {
    const key = String(warehouseId);
    if (this.orderCoordinators.has(key)) return this.orderCoordinators.get(key);

    const engine = await this.getEngine(warehouseId);
    if (!engine) return null;

    const coordinator = new OrderCoordinator(engine);
    this.orderCoordinators.set(key, coordinator);
    return coordinator;
  }

  /** Persists a robot snapshot's physical fields back to MongoDB. Task
   * queue/path stay in-memory only - see the comment on Robot.taskQueue.
   * For a single robot changing outside a tick (a manual assign/charge/
   * clear-error/mark-broken action) - see persistRobots below for the
   * per-tick, many-robots-at-once case this doesn't cover well. */
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
   * mean up to 50 separate write operations every 500ms; it's now one.
   * `ordered: false` is safe here because engine.tick() only ever produces
   * at most one snapshot per robot per tick (see robotEngine.js), so this
   * array can never contain two operations targeting the same document -
   * there's nothing for write order to matter for.
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

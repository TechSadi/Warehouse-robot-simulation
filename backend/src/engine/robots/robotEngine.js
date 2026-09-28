const { findPath } = require('../pathfinding/astar');
const RobotEngineError = require('./robotEngineError');
const { DynamicObstacleManager } = require('../obstacles/dynamicObstacles');
const robotLifecycle = require('../../domain/robotLifecycle');

const STATUSES = { IDLE: 'idle', MOVING: 'moving', CHARGING: 'charging', ERROR: 'error' };

const DEFAULT_SPEED = 2; // cells per second
const BATTERY_DRAIN_PER_CELL = 0.5; // percent, per cell of distance actually traveled
const CHARGE_RATE_PER_SECOND = 20; // percent per second while charging
// Milestone 13: an idle robot at or below this battery percentage
// autonomously heads for the nearest reachable charging station instead of
// waiting to run out mid-task later - see _maybeAutoCharge.
const LOW_BATTERY_THRESHOLD = 20;
// After a failed attempt to find a reachable charging station (none exist,
// or every one is currently cut off), wait this many ticks before trying
// again instead of re-running pathfinding against every station every
// single tick - mirrors the same "don't hammer it every tick" reasoning as
// DEADLOCK_REROUTE_THRESHOLD below.
const AUTO_CHARGE_RETRY_TICKS = 10;
// After this many consecutive ticks blocked by another robot, try routing
// around the congestion instead of waiting indefinitely - this is what
// prevents two robots deadlocked in a head-on wait from staying stuck
// forever when a bypass actually exists.
const DEADLOCK_REROUTE_THRESHOLD = 3;
// A robot's queue is runtime-only and grows one entry per assignTask call.
// `POST /api/robots/:id/tasks` is a client-driven path into it, so without
// a ceiling a caller can make one robot's queue grow without bound - and
// every entry is re-planned as the robot works through it. 64 queued
// destinations is far past anything the simulation produces on its own
// (dispatch queues at most two per order) while still being a hard stop.
const MAX_TASK_QUEUE = 64;
// How much charge a travelling robot keeps in hand on top of what its
// remaining route costs. Without a reserve the break-even point is exactly
// "arrives with 0%", which every rounding error and every reroute pushes
// the wrong side of. See _maybeDivertToCharge.
const BATTERY_RESERVE_PERCENT = 5;
// How many consecutive ticks a robot may sit stranded with a flat battery
// before maintenance retrieves it (see _recoverStranded). Long enough that
// an operator watching the fleet sees the fault happen and can intervene,
// short enough that an unattended simulation does not slowly fill up with
// permanent obstacles.
const STRANDED_RECOVERY_TICKS = 20;
// How far (in steps) an idle robot will look for a free cell to step
// aside into when it is standing where another robot needs to go. See
// _yieldCell.
const YIELD_SEARCH_RADIUS = 8;
// How many robots deep a request to step aside may pass along when the
// robot asked is boxed in by other idle robots - see _makeRoom.
const YIELD_CHAIN_DEPTH = 3;
const EPSILON = 1e-9;

const ORTHOGONAL_STEPS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

function cellKey(cell) {
  return `${cell.x}:${cell.y}`;
}

function isWalkable(grid, x, y) {
  return x >= 0 && y >= 0 && x < grid.cols && y < grid.rows && !grid.isBlocked(x, y);
}

function normalizeRotation(degrees) {
  const r = degrees % 360;
  return r < 0 ? r + 360 : r;
}

/** Heading angle (screen-space: 0=east, 90=south, 180=west, 270=north). */
function headingFromDelta(dx, dy) {
  return normalizeRotation((Math.atan2(dy, dx) * 180) / Math.PI);
}

function clonePoint(p) {
  return p ? { x: p.x, y: p.y } : null;
}

function manhattanDistance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Manages the live simulation state of every robot in one warehouse. Takes
 * only a `{ rows, cols, isBlocked(x, y), isCharging(x, y) }` grid - it has
 * no idea whether that's backed by MongoDB, a test fixture, or anything
 * else, and holds no reference to any particular robot's storage record.
 * That's what makes one engine instance safe to reuse for every robot in
 * a warehouse: state lives entirely in `this.robots`, keyed by id, with no
 * cross-robot shared mutable state beyond the grid itself (which is only
 * ever read, never written, by this engine).
 *
 * Multi-robot coordination (Milestone 8): every robot in `this.robots` is
 * visible to every other robot's movement check each tick - that shared
 * map *is* the "robot communication" channel here; there's no separate
 * message-passing layer to build in a single-process simulation. A robot
 * only ever advances into a cell no other robot currently occupies
 * (collision avoidance); if its next cell is taken, it holds position
 * instead (waiting logic) rather than colliding or being teleported. If it
 * stays blocked for several consecutive ticks, it tries routing around the
 * congestion, treating other robots' current cells as temporary obstacles
 * (dynamic rerouting) - which is also what breaks a head-on standoff
 * between two robots waiting on each other (deadlock prevention), whenever
 * a bypass actually exists.
 *
 * Dynamic obstacles (Milestone 9): human workers, temporary obstacles, and
 * construction zones (`addObstacle`/`removeObstacle`) sit on top of the
 * static warehouse grid and can appear or expire mid-simulation. Unlike
 * another robot possibly moving out of the way soon, these don't clear up
 * on their own, so a robot reroutes around one the moment it appears
 * anywhere on its remaining path - it doesn't wait out the same threshold
 * used for robot-vs-robot congestion. A "broken robot" is just a robot in
 * the `error` state (see `markBroken`); it already blocks its own cell via
 * the same collision logic as any other robot, and other robots treat it
 * the same way they treat a dynamic obstacle (immediate reroute) rather
 * than the gentler wait-then-reroute given to a robot that might simply be
 * about to move.
 *
 * Battery charging (Milestone 13): an idle robot whose battery drops to
 * `LOW_BATTERY_THRESHOLD` or below autonomously queues a trip to the
 * nearest *reachable* charging station and starts charging on arrival,
 * rather than waiting to run dry mid-task later and land in the `error`
 * state that used to be the only outcome. This never preempts an
 * explicitly assigned destination - it only kicks in once a robot has
 * nothing else queued. See `_maybeAutoCharge`.
 */
class RobotEngine {
  /**
   * @param {any} grid
   * @param {{autoRecoverStranded?: boolean}} [options]
   *   `autoRecoverStranded` (default true) lets maintenance retrieve a
   *   robot whose battery reached zero away from a charger - the one
   *   failure a robot genuinely cannot recover from under its own power.
   *   Switchable off for tests that want to observe the stranded state
   *   itself rather than the recovery from it.
   */
  constructor(grid, options = {}) {
    this.grid = grid;
    this.robots = new Map();
    this.dynamicObstacles = new DynamicObstacleManager();
    this.autoRecoverStranded = options.autoRecoverStranded !== false;
    // Computed once - the grid is read-only for this engine's lifetime
    // (see the class doc comment above), so there's no need to rescan it
    // on every low-battery robot's every tick.
    this._chargingCells = this._scanChargingCells();
    this._dockApron = this._scanDockApron();
    /** Retrievals performed since the last takeRecoveries() call, so the
     * caller can log and broadcast them - the engine itself has no I/O. */
    this._recoveries = [];
  }

  /** Registers a new robot at `position` and returns its initial state. */
  spawnRobot({ id, name, position, speed = DEFAULT_SPEED, battery = 100 }) {
    if (!id) throw new RobotEngineError('INVALID_ARGUMENT', 'spawnRobot requires an id');
    if (!position || !Number.isInteger(position.x) || !Number.isInteger(position.y)) {
      throw new RobotEngineError('INVALID_ARGUMENT', 'spawnRobot requires an integer {x, y} cell position');
    }
    if (this.robots.has(id)) {
      throw new RobotEngineError('DUPLICATE_ROBOT', `A robot with id "${id}" already exists`);
    }
    if (!isWalkable(this._effectiveGrid(), position.x, position.y)) {
      throw new RobotEngineError('UNWALKABLE_POSITION', `Cannot spawn a robot on a blocked cell (${position.x}, ${position.y})`);
    }
    if (this._occupantOf({ x: position.x, y: position.y }, null)) {
      throw new RobotEngineError('CELL_OCCUPIED', `Cannot spawn a robot on a cell another robot already occupies (${position.x}, ${position.y})`);
    }

    const robot = {
      id,
      name: name || id,
      position: { x: position.x, y: position.y },
      currentCell: { x: position.x, y: position.y },
      rotation: 0,
      speed,
      battery: Math.max(0, Math.min(100, battery)),
      status: STATUSES.IDLE,
      path: null,
      pathIndex: 0,
      currentTask: null,
      taskQueue: [],
      errorReason: null,
      waitingTicks: 0,
      autoChargeCooldown: 0,
      // Set when a trip was queued *in order to* charge, so arrival at the
      // station starts charging immediately instead of going idle and
      // waiting for the next tick's low-battery check to notice again.
      pendingCharge: false,
      // Set while the robot is only stepping out of another robot's way (see
      // _stepAside) - its currentTask is then a parking spot, not real work.
      yielding: false,
      // Consecutive ticks spent stranded with a flat battery - see
      // _recoverStranded.
      strandedTicks: 0,
    };
    this.robots.set(id, robot);
    return this._snapshot(robot);
  }

  /** Removes a robot. Returns true if it existed. */
  removeRobot(id) {
    return this.robots.delete(id);
  }

  /**
   * Re-seeds a robot's work from persisted state, at engine construction
   * time - the one moment state flows from MongoDB into the engine rather
   * than out of it (see services/simulationManager.js).
   *
   * `currentTask` is the destination the robot was actually driving to,
   * so it goes back to the *front* of the queue: a robot that was halfway
   * through a delivery resumes that delivery rather than starting the one
   * behind it. The computed path is deliberately not restored - it lived
   * only in memory precisely because it describes a world that may have
   * changed while the process was down - so the destination is replanned
   * from wherever the robot actually came back.
   *
   * Unlike `assignTask` this does not reject an unwalkable destination:
   * the layout may have changed under a task that was legal when it was
   * issued. Such a task is kept and fails the normal way (the robot ends
   * up in `error` with "No path to destination"), which is visible and
   * retryable, rather than being silently dropped here.
   *
   * Returns the robot's snapshot, or null if there is no such robot.
   */
  restoreTasks(id, { currentTask = null, taskQueue = [] } = {}) {
    const robot = this.robots.get(id);
    if (!robot) return null;

    const cells = [currentTask, ...taskQueue]
      .filter((t) => t && Number.isInteger(t.x) && Number.isInteger(t.y))
      .slice(0, MAX_TASK_QUEUE)
      .map((t) => ({ x: t.x, y: t.y }));
    if (cells.length === 0) return this._snapshot(robot);

    robot.taskQueue = cells;
    // A robot restored into `error` or `charging` keeps that state and its
    // queue: it resumes when it is cleared or finishes charging, through
    // the same paths any other robot does.
    if (robot.status === STATUSES.IDLE) this._tryStartNextTask(robot);
    return this._snapshot(robot);
  }

  /** Drains the list of maintenance retrievals performed since the last
   * call. The engine has no I/O of its own, so the caller (tickRunner) is
   * what turns these into a log line and a client notification. */
  takeRecoveries() {
    const recoveries = this._recoveries;
    this._recoveries = [];
    return recoveries;
  }

  getRobot(id) {
    const robot = this.robots.get(id);
    return robot ? this._snapshot(robot) : null;
  }

  getAllRobots() {
    return Array.from(this.robots.values(), (r) => this._snapshot(r));
  }

  /**
   * Queues a destination for a robot. If the robot is idle, it starts
   * moving immediately; otherwise the destination waits its turn and is
   * picked up automatically once the robot becomes idle again (path
   * complete, or charging finishes).
   */
  assignTask(id, destination) {
    const robot = this._requireRobot(id);
    if (!Number.isInteger(destination.x) || !Number.isInteger(destination.y)) {
      throw new RobotEngineError('INVALID_ARGUMENT', 'Destination must have integer cell coordinates');
    }
    if (!isWalkable(this._effectiveGrid(), destination.x, destination.y)) {
      throw new RobotEngineError('UNWALKABLE_POSITION', `Destination (${destination.x}, ${destination.y}) is not walkable`);
    }
    if (robot.taskQueue.length >= MAX_TASK_QUEUE) {
      throw new RobotEngineError('TASK_QUEUE_FULL', `Robot "${id}" already has ${MAX_TASK_QUEUE} destinations queued`);
    }

    robot.taskQueue.push({ x: destination.x, y: destination.y });
    if (robot.status === STATUSES.IDLE) {
      this._tryStartNextTask(robot);
    }
    return this._snapshot(robot);
  }

  /** Starts charging. Only valid from idle or error, and only while
   * standing on a charging cell - a robot can't recharge mid-aisle. */
  startCharging(id) {
    const robot = this._requireRobot(id);
    if (robot.status === STATUSES.MOVING) {
      throw new RobotEngineError('INVALID_TRANSITION', 'Cannot start charging while moving');
    }
    if (robot.status === STATUSES.CHARGING) return this._snapshot(robot);
    if (!this.grid.isCharging(robot.currentCell.x, robot.currentCell.y)) {
      throw new RobotEngineError('NOT_AT_CHARGING_STATION', 'Robot must be on a charging cell to charge');
    }
    this._setStatus(robot, STATUSES.CHARGING);
    robot.errorReason = null;
    return this._snapshot(robot);
  }

  /** Discards every destination this robot has queued, and abandons the one
   * it is currently driving to, leaving it idle where it stands (or, if it
   * is mid-cell, at the cell it last fully entered). Used when the *reason*
   * for those destinations goes away - a cancelled or reassigned order -
   * so the robot does not keep driving a route nobody is waiting on. A
   * robot in the `error` state keeps that state: clearing its work is not
   * repairing it. */
  clearTasks(id) {
    const robot = this.robots.get(id);
    if (!robot) return null;
    robot.taskQueue = [];
    robot.currentTask = null;
    robot.yielding = false;
    robot.path = null;
    robot.pathIndex = 0;
    robot.waitingTicks = 0;
    robot.pendingCharge = false;
    if (robot.status === STATUSES.MOVING) {
      robot.position = { x: robot.currentCell.x, y: robot.currentCell.y };
      this._setStatus(robot, STATUSES.IDLE);
    }
    return this._snapshot(robot);
  }

  /** Recovers a robot from the error state (e.g. after manual intervention
   * or moving it back onto a charging station). Re-attempts any queued task. */
  clearError(id) {
    const robot = this._requireRobot(id);
    if (robot.status !== STATUSES.ERROR) return this._snapshot(robot);
    this._setStatus(robot, STATUSES.IDLE);
    robot.errorReason = null;
    robot.strandedTicks = 0; // a person got there before maintenance did
    this._tryStartNextTask(robot);
    return this._snapshot(robot);
  }

  /** Marks a robot as broken down (Milestone 9's "broken robots" dynamic
   * obstacle type) - the same `error` state as a depleted battery or an
   * unreachable destination, just triggered explicitly. It blocks its own
   * cell like any stationary robot, and other robots treat it as urgently
   * as a human worker or construction zone rather than waiting it out, on
   * the assumption a breakdown won't resolve itself soon. Recover it the
   * same way as any other error, via `clearError`. */
  markBroken(id, reason = 'Robot marked as broken') {
    const robot = this._requireRobot(id);
    this._setStatus(robot, STATUSES.ERROR);
    robot.errorReason = reason;
    robot.pendingCharge = false;
    robot.strandedTicks = 0;
    // A robot stopped mid-cell parks on the cell it last fully entered -
    // an integer cell is the only position the rest of the engine (and A*)
    // can plan from once it recovers.
    robot.position = { x: robot.currentCell.x, y: robot.currentCell.y };
    this._requeueCurrentTask(robot);
    robot.path = null;
    robot.pathIndex = 0;
    return this._snapshot(robot);
  }

  addObstacle(config) {
    return this.dynamicObstacles.add(config);
  }

  removeObstacle(id) {
    return this.dynamicObstacles.remove(id);
  }

  getObstacle(id) {
    return this.dynamicObstacles.get(id);
  }

  getObstacles() {
    return this.dynamicObstacles.getAll();
  }

  /** Re-seeds the runtime hazards from persisted state - see
   * DynamicObstacleManager.restore and models/Warehouse.js. */
  restoreObstacles(obstacles) {
    return this.dynamicObstacles.restore(obstacles);
  }

  /**
   * Advances the whole simulation by `deltaSeconds`. Moving robots consume
   * their speed*deltaSeconds distance budget across the current path,
   * across as many completed waypoints/tasks as that budget allows (so a
   * large or lagging tick doesn't lose motion, and small frequent ticks
   * produce smooth, continuously-interpolated positions). Returns the
   * snapshots of every robot that changed this tick, ready to hand to a
   * caller that persists them or (in a later milestone) broadcasts them.
   */
  tick(deltaSeconds) {
    this.dynamicObstacles.tick(deltaSeconds);

    const changed = [];
    // Longest-waiting robots get processed (and so get first claim on any
    // contested cell) first - otherwise Map iteration order would let the
    // same robot always win a standoff.
    const robots = [...this.robots.values()].sort((a, b) => b.waitingTicks - a.waitingTicks);
    for (const robot of robots) {
      if (robot.status === STATUSES.MOVING) {
        // Checked before the hazard reroute, because diverting replaces
        // the path a reroute would have been repairing.
        this._maybeDivertToCharge(robot);
        if (this._hasHazardOnPath(robot)) this._rerouteAroundHazards(robot);
        if (this._advance(robot, deltaSeconds)) changed.push(this._snapshot(robot));
      } else if (robot.status === STATUSES.CHARGING) {
        this._charge(robot, deltaSeconds);
        changed.push(this._snapshot(robot));
      } else if (robot.status === STATUSES.IDLE) {
        if (this._maybeAutoCharge(robot) || this._maybeClearDock(robot)) changed.push(this._snapshot(robot));
      } else if (robot.status === STATUSES.ERROR) {
        if (this._recoverStranded(robot)) changed.push(this._snapshot(robot));
      }
    }
    return changed;
  }

  // --- internals -----------------------------------------------------

  _requireRobot(id) {
    const robot = this.robots.get(id);
    if (!robot) throw new RobotEngineError('ROBOT_NOT_FOUND', `No robot with id "${id}"`);
    return robot;
  }

  /**
   * The single place a robot's status is written.
   *
   * The legal moves are declared once, in domain/robotLifecycle.js, and
   * shared with the REST layer - but until now only the REST layer was
   * checked against them, while the engine assigned `robot.status`
   * directly in eight places. Nothing forced the two to agree, so the
   * authoritative state machine was authoritative over the side door and
   * not over the front one. Routing every engine transition through this
   * assertion makes the table describe what actually happens: an illegal
   * move is a programming error here and fails loudly in tests rather than
   * silently producing a robot in a state the rest of the system does not
   * expect (a `moving` robot with no path, a `charging` robot mid-aisle).
   */
  _setStatus(robot, next) {
    if (robot.status === next) return;
    robotLifecycle.assertTransition(robot.status, next);
    robot.status = next;
  }

  _charge(robot, deltaSeconds) {
    robot.battery = Math.min(100, robot.battery + CHARGE_RATE_PER_SECOND * deltaSeconds);
    robot.pendingCharge = false; // it is charging; the intent is discharged
    if (robot.battery >= 100) {
      this._setStatus(robot, STATUSES.IDLE);
      // Whatever it was carrying before it diverted is still at the front
      // of the queue, so a full battery resumes the interrupted trip.
      this._tryStartNextTask(robot);
    }
  }

  /**
   * Stops a robot continuing a route its remaining charge cannot cover.
   *
   * `_maybeAutoCharge` below only ever looks at *idle* robots, so the one
   * way a robot could still strand itself was the obvious one: run flat
   * part-way through a long trip. That was the root cause behind the
   * manual-`clearError` limitation - a robot at 0% away from a charger
   * cannot move to one under its own power, so it stayed broken until a
   * person intervened. Preventing the depletion is the real fix;
   * `_recoverStranded` only handles what prevention cannot (a robot that
   * was already flat, or one whose reserve was eaten by a reroute).
   *
   * Deliberately only applied once a robot has actually left its origin
   * (`pathIndex > 0`). Deciding at dispatch time is the *dispatcher's* job
   * and it already does it - orderService filters out robots at or below
   * the low-battery threshold - so re-litigating the first step here would
   * only second-guess a decision made with more information (which orders
   * are pending, which robots are free) than this function has. What this
   * adds is re-evaluation *during* the trip, where the estimate genuinely
   * changes: a reroute around an obstacle can make a route materially
   * longer than the one the robot set out on.
   *
   * Returns true if the robot was diverted.
   */
  _maybeDivertToCharge(robot) {
    if (!robot.path || robot.pathIndex <= 0) return false;
    if (robot.pendingCharge) return false; // already on its way to a station

    const remainingCells = robot.path.length - robot.pathIndex;
    const needed = remainingCells * BATTERY_DRAIN_PER_CELL + BATTERY_RESERVE_PERCENT;
    if (robot.battery >= needed) return false;

    const station = this._findReachableChargingCell(robot.currentCell);
    if (!station) return false;

    // Standing on one already - stop here and charge rather than driving
    // off to a further station.
    if (station.x === robot.currentCell.x && station.y === robot.currentCell.y) {
      this._requeueCurrentTask(robot);
      robot.path = null;
      robot.pathIndex = 0;
      this._setStatus(robot, STATUSES.IDLE);
      this._setStatus(robot, STATUSES.CHARGING);
      robot.pendingCharge = false;
      return true;
    }

    // The interrupted destination goes back to the front of the queue, so
    // the trip resumes by itself once the battery is full.
    this._requeueCurrentTask(robot);
    robot.taskQueue.unshift(station);
    robot.path = null;
    robot.pathIndex = 0;
    robot.pendingCharge = true;
    if (!this._tryStartNextTask(robot)) {
      // The station stopped being reachable between the check above and
      // the plan - drop the intent rather than leaving a robot marked as
      // heading somewhere it is not.
      robot.pendingCharge = false;
    }
    return true;
  }

  /**
   * Maintenance retrieval for a robot whose battery reached zero away from
   * a charging station.
   *
   * This is the one fault in the simulation a robot cannot work its way
   * out of: `clearError` returns it to `idle`, but idle at 0% still cannot
   * move, so it sat as a permanent obstacle blocking its cell until a
   * person clicked a button. Every other error state either resolves
   * itself or is the direct result of something a client asked for.
   *
   * Modelled as a retrieval rather than as free charge: the robot is moved
   * to the nearest free charging station and charges there, which is what
   * a warehouse would actually do with a dead unit. It is the one place
   * the engine relocates a robot without driving it - it has no charge to
   * drive with - and it only happens after STRANDED_RECOVERY_TICKS, so an
   * operator watching the fleet sees the fault before it is cleaned up.
   *
   * Returns true if the robot was recovered this tick.
   */
  _recoverStranded(robot) {
    if (!this.autoRecoverStranded) return false;
    // Only flat batteries. A robot marked broken by an operator, or one
    // that could not find a path, is not stranded - it is in a state
    // somebody asked for, and clearing it is their call.
    if (robot.battery > 0) return false;

    robot.strandedTicks += 1;
    if (robot.strandedTicks < STRANDED_RECOVERY_TICKS) return false;

    const station = this._chargingCells.find(
      (cell) => !this._occupantOf(cell, robot.id) && isWalkable(this._effectiveGrid(), cell.x, cell.y)
    );
    // Nowhere to take it. Reset the counter so this is retried a threshold
    // later (a station may free up, or an obstacle be cleared) rather than
    // re-scanning every tick forever.
    if (!station) {
      robot.strandedTicks = 0;
      return false;
    }

    const from = { x: robot.currentCell.x, y: robot.currentCell.y };
    robot.position = { x: station.x, y: station.y };
    robot.currentCell = { x: station.x, y: station.y };
    robot.strandedTicks = 0;
    robot.errorReason = null;
    robot.waitingTicks = 0;
    this._setStatus(robot, STATUSES.IDLE);
    this._setStatus(robot, STATUSES.CHARGING);
    this._recoveries.push({ robotId: robot.id, from, to: { x: station.x, y: station.y } });
    return true;
  }

  /** Milestone 13: called for every idle robot each tick. If its battery is
   * low, nothing else is queued, and it isn't already standing on a
   * charging cell, it autonomously routes itself to the nearest reachable
   * one; if it's already there, it just starts charging directly. Returns
   * true if this changed the robot's state (moving or now charging), so
   * the caller knows to report it - false if there's nothing to do (battery
   * is fine, something's already queued, it's completely out of charge and
   * can't move anywhere, or no reachable station exists right now). */
  _maybeAutoCharge(robot) {
    if (robot.battery > LOW_BATTERY_THRESHOLD) return false;
    if (robot.taskQueue.length > 0) return false; // don't preempt an explicitly queued destination
    if (robot.battery <= 0) return false; // can't move to get there anyway

    if (this.grid.isCharging(robot.currentCell.x, robot.currentCell.y)) {
      this._setStatus(robot, STATUSES.CHARGING);
      robot.errorReason = null;
      return true;
    }

    if (robot.autoChargeCooldown > 0) {
      robot.autoChargeCooldown -= 1;
      return false;
    }

    const target = this._findReachableChargingCell(robot.currentCell);
    if (!target) {
      robot.autoChargeCooldown = AUTO_CHARGE_RETRY_TICKS;
      return false;
    }

    robot.taskQueue.push(target);
    // Recorded as an *intent*, not just a destination. Without it the robot
    // arrives, goes idle, and only starts charging on the following tick
    // when this same check runs again and happens to notice it is standing
    // on a station - a tick during which the dispatcher can hand it another
    // order and send it away again still flat.
    robot.pendingCharge = true;
    if (!this._tryStartNextTask(robot)) {
      robot.pendingCharge = false;
      return false;
    }
    return true;
  }

  /** Every charging cell in the warehouse, closest-first by Manhattan
   * distance from `fromCell`, tried in order via real pathfinding until one
   * is actually reachable (skipping over any that are walled off or
   * currently cut off by a dynamic obstacle). Returns null if there are no
   * charging cells at all, or none of them are reachable right now. */
  _findReachableChargingCell(fromCell) {
    if (this._chargingCells.length === 0) return null;

    const candidates = [...this._chargingCells].sort(
      (a, b) => manhattanDistance(a, fromCell) - manhattanDistance(b, fromCell)
    );
    for (const cell of candidates) {
      const result = findPath(this._effectiveGrid(), fromCell, cell);
      if (result.found) return cell;
    }
    return null;
  }

  /** Every cell the grid reports as a charging station, scanned once at
   * construction time (see the constructor) rather than per lookup. */
  _scanChargingCells() {
    const cells = [];
    for (let y = 0; y < this.grid.rows; y++) {
      for (let x = 0; x < this.grid.cols; x++) {
        if (this.grid.isCharging(x, y)) cells.push({ x, y });
      }
    }
    return cells;
  }

  /** Every walkable cell on or orthogonally next to a dock, as cellKey()s -
   * the space a delivery needs kept open. Scanned once, like the charging
   * cells. A grid with no notion of docks has no apron. */
  _scanDockApron() {
    const apron = new Set();
    if (!this.grid.isDock) return apron;
    for (let y = 0; y < this.grid.rows; y++) {
      for (let x = 0; x < this.grid.cols; x++) {
        if (!this.grid.isDock(x, y)) continue;
        for (const { dx, dy } of [{ dx: 0, dy: 0 }, ...ORTHOGONAL_STEPS]) {
          if (isWalkable(this.grid, x + dx, y + dy)) apron.add(cellKey({ x: x + dx, y: y + dy }));
        }
      }
    }
    return apron;
  }

  /** Called for every idle robot each tick. A robot with nothing to do that
   * is standing on a dock, or right next to one, drives off to park on open
   * floor. Otherwise robots that finish a delivery stay where they stopped,
   * and after a few deliveries a dock is walled in by parked robots that
   * cannot step aside for the next courier because each is blocking the
   * others. The coordinator has already seen the robot arrive (it reacts to
   * the tick the robot went idle), so leaving on a later tick loses nothing.
   * Returns true if the robot is now moving. */
  _maybeClearDock(robot) {
    if (robot.taskQueue.length > 0 || robot.battery <= 0) return false;
    if (!this._dockApron.has(cellKey(robot.currentCell))) return false;
    return this._stepAside(robot, this._dockApron);
  }

  /** Pops the next queued destination (if any) and computes a path to it.
   * Returns true if the robot is now moving. */
  _tryStartNextTask(robot) {
    if (robot.taskQueue.length === 0) return false;
    if (robot.battery <= 0) return false; // stay idle; can't move with no charge

    const destination = robot.taskQueue.shift();
    // Planned from `currentCell`, never from `position`. The two differ
    // only while a robot is part-way between cells, but `position` is then
    // fractional - and A* is a *grid* search, so a fractional start cell
    // matches no node it can ever expand: the search would explore the
    // whole reachable grid and report "no path" for a destination that is
    // plainly reachable. That was reachable in practice via clearError() on
    // a robot whose battery ran out mid-step.
    const result = findPath(this._effectiveGrid(), robot.currentCell, destination);

    if (!result.found) {
      this._setStatus(robot, STATUSES.ERROR);
      robot.errorReason = `No path to destination (${destination.x}, ${destination.y})`;
      // Keep the destination retryable (e.g. via clearError() once an
      // obstacle is cleared) instead of silently dropping it.
      robot.taskQueue.unshift(destination);
      robot.currentTask = null;
      robot.path = null;
      return false;
    }

    // findPath includes the start cell; drop it since we're already there.
    const waypoints = result.path.slice(1);
    if (waypoints.length === 0) {
      // Already at the destination - nothing to do, try the next task.
      return this._tryStartNextTask(robot);
    }

    robot.path = waypoints;
    robot.pathIndex = 0;
    robot.currentTask = destination;
    this._setStatus(robot, STATUSES.MOVING);
    return true;
  }

  /** Consumes `deltaSeconds` worth of movement across the current path (and,
   * if it completes, subsequent queued tasks) until the budget runs out,
   * the robot arrives with an empty queue, the battery runs out, or it's
   * blocked by another robot occupying the next cell. */
  _advance(robot, deltaSeconds) {
    let distanceBudget = robot.speed * deltaSeconds;
    let moved = false;

    while (robot.status === STATUSES.MOVING) {
      if (!robot.path || robot.pathIndex >= robot.path.length) {
        // Path exhausted - always resolve this before looking at the
        // remaining budget, otherwise a tick that finishes its path with
        // zero budget left over would never notice the path is done.
        const steppedAside = robot.yielding;
        robot.path = null;
        robot.pathIndex = 0;
        robot.currentTask = null;
        robot.yielding = false;

        // Arrived at a station it set out for specifically in order to
        // charge (see _maybeDivertToCharge / _maybeAutoCharge). Charging
        // starts here rather than one tick later, and the rest of the
        // queue - including whatever trip was interrupted - waits until
        // the battery is full, which is what _charge resumes. A robot that
        // only stepped aside on the way keeps that intent for the real trip.
        if (steppedAside) {
          if (!this._tryStartNextTask(robot) && robot.status === STATUSES.MOVING) this._setStatus(robot, STATUSES.IDLE);
          continue;
        }
        if (robot.pendingCharge && this.grid.isCharging(robot.currentCell.x, robot.currentCell.y)) {
          robot.pendingCharge = false;
          this._setStatus(robot, STATUSES.IDLE);
          this._setStatus(robot, STATUSES.CHARGING);
          robot.errorReason = null;
          moved = true;
          break;
        }
        robot.pendingCharge = false;

        if (!this._tryStartNextTask(robot)) {
          if (robot.status === STATUSES.MOVING) this._setStatus(robot, STATUSES.IDLE);
          break;
        }
        continue; // re-enter loop to spend any leftover budget on the new path
      }

      const target = robot.path[robot.pathIndex];

      // Collision avoidance: don't enter a cell another robot currently
      // occupies. Checked at every waypoint boundary, not just once per
      // tick, so a cell that becomes occupied mid-tick (by a
      // higher-priority robot processed earlier this same tick) is still
      // respected.
      if (this._occupantOf(target, robot.id)) {
        if (!this._handleBlocked(robot, target)) break; // still blocked - hold position
        continue; // rerouted onto a new path - re-evaluate from the top
      }
      if (robot.waitingTicks > 0) robot.waitingTicks = 0; // clear to move; no longer waiting

      if (distanceBudget <= EPSILON) break; // path remains, but no budget left this tick

      const dx = target.x - robot.position.x;
      const dy = target.y - robot.position.y;
      const segmentDistance = Math.hypot(dx, dy);

      if (segmentDistance <= distanceBudget + EPSILON) {
        // Reaches (or exactly meets) this waypoint.
        if (segmentDistance > EPSILON) robot.rotation = headingFromDelta(dx, dy);
        robot.position = { x: target.x, y: target.y };
        robot.currentCell = { x: target.x, y: target.y };
        distanceBudget -= segmentDistance;
        moved = true;
        if (!this._drainBattery(robot, segmentDistance)) return true; // depleted mid-step
        robot.pathIndex += 1;
      } else {
        // Partial step along this segment. The departure cell (currentCell)
        // stays reserved until the cell is fully entered - see the class
        // doc comment on why that's the simple, safe choice.
        const ratio = distanceBudget / segmentDistance;
        robot.rotation = headingFromDelta(dx, dy);
        robot.position = {
          x: robot.position.x + dx * ratio,
          y: robot.position.y + dy * ratio,
        };
        moved = true;
        const traveled = distanceBudget;
        distanceBudget = 0;
        if (!this._drainBattery(robot, traveled)) return true;
      }
    }

    return moved;
  }

  /** Called when a robot's next waypoint is occupied by another robot.
   * Tracks how long it's been stuck and, past the threshold, attempts to
   * route around the congestion instead of waiting forever. Returns true
   * if it found a new route (caller should re-evaluate this tick), false
   * if it should just keep waiting.
   *
   * If the robot in the way is idle and there is no route around it, it is
   * asked to step aside. Rerouting alone cannot clear that case when the
   * occupied cell is the destination itself - a robot that finished a
   * delivery used to stay parked on the dock, and every later delivery
   * there queued behind it forever. */
  _handleBlocked(robot, blockedCell) {
    robot.waitingTicks += 1;

    // A robot that is itself only stepping aside has no real destination,
    // so rather than waiting on its chosen spot it picks another free one.
    // Waiting would let a ring of robots each hold the cell the next one
    // wants, with nobody able to give way.
    if (robot.yielding) {
      robot.waitingTicks = 0;
      return this._stepAside(robot, new Set());
    }

    // An idle robot standing on this robot's destination is asked to move
    // straight away - no route around it can ever get there.
    const occupant = this.robots.get(this._occupantOf(blockedCell, robot.id));
    const blocksDestination =
      robot.currentTask && robot.currentTask.x === blockedCell.x && robot.currentTask.y === blockedCell.y;
    if (occupant && blocksDestination && this._yieldCell(occupant, robot)) return false; // it's moving off - wait for it

    if (robot.waitingTicks < DEADLOCK_REROUTE_THRESHOLD) return false;

    const rerouted = this._rerouteAroundHazards(robot);
    // Reset the counter either way - whether or not this attempt worked,
    // give it a fresh threshold's worth of ticks before trying again,
    // rather than re-running A* every single tick while stuck.
    robot.waitingTicks = 0;
    if (rerouted) return true;

    // No way round - an idle robot in the way steps aside after all.
    if (occupant && this._yieldCell(occupant, robot)) return false;

    // Rerouting cannot help when the robot in the way is standing on this
    // robot's destination and wants to go where this one stands - a
    // head-on swap, or a longer ring of robots each waiting on the next.
    // One of them has to back off: it steps aside and then resumes its
    // trip. The robot with the greater id does, so the two do not normally
    // both back off at once and any ring has at least one robot that gives
    // way - unless that robot is boxed in with nowhere to go (typically a
    // robot on a dock that the others are all queued around), in which
    // case the other one makes room instead. An idle occupant has already
    // been asked to step aside above, so reaching here means it cannot.
    if (occupant?.status !== STATUSES.MOVING && occupant?.status !== STATUSES.IDLE) return false;
    const occupantCanBackOff =
      occupant.status === STATUSES.MOVING &&
      robot.id < occupant.id &&
      this._findYieldSpot(occupant, this._remainingRoute(robot)) !== null;
    if (occupantCanBackOff) return false;
    return this._stepAside(robot, this._remainingRoute(occupant));
  }

  /** Moves an idle robot with nothing queued off the cell `forRobot`
   * needs. Only robots with nothing to do are moved: a charging, broken or
   * busy robot keeps its place, and the blocked robot falls back to
   * waiting and rerouting as before. Returns true if the robot is moving
   * out of the way, or room is being made for it to - either way the
   * blocked robot should wait rather than back off. */
  _yieldCell(robot, forRobot) {
    return this._makeRoom(robot, this._remainingRoute(forRobot), YIELD_CHAIN_DEPTH);
  }

  _canYield(robot) {
    return robot.status === STATUSES.IDLE && robot.taskQueue.length === 0 && robot.battery > 0;
  }

  /** Steps an idle robot aside to a cell outside `keepClear`. If it is boxed
   * in by other idle robots - the dock walled in on three sides, with the
   * courier on the fourth - one of those neighbours makes room first (and
   * so on, up to `depth` robots deep), and this robot follows on a later
   * tick once the cell is free. Without that, the courier's only fallback
   * was to back off and come straight back, forever. */
  _makeRoom(robot, keepClear, depth) {
    if (!this._canYield(robot)) return false;
    if (this._stepAside(robot, keepClear)) return true;
    if (depth <= 0) return false;

    const neighbours = [];
    for (const { dx, dy } of ORTHOGONAL_STEPS) {
      const cell = { x: robot.currentCell.x + dx, y: robot.currentCell.y + dy };
      const occupant = this.robots.get(this._occupantOf(cell, robot.id));
      if (occupant) neighbours.push(occupant);
    }
    // A neighbour already on its way out frees a cell once it gets there.
    if (neighbours.some((n) => n.yielding)) return true;

    // The neighbour must not settle on this robot's cell or anything the
    // original requester still needs.
    const clear = new Set(keepClear).add(cellKey(robot.currentCell));
    return neighbours.some((n) => this._makeRoom(n, clear, depth - 1));
  }

  /** The cells still ahead on a robot's current path, as cellKey()s. */
  _remainingRoute(robot) {
    const cells = new Set();
    for (let i = robot.pathIndex; i < (robot.path?.length ?? 0); i++) cells.add(cellKey(robot.path[i]));
    return cells;
  }

  /** Sends `robot` to the best free cell within YIELD_SEARCH_RADIUS that is
   * not in `keepClear`, and marks it as `yielding`. "Best" is the closest,
   * with a penalty for cells on another moving robot's route and for docks
   * and charging stations - so the robot neither steps into someone else's
   * way nor goes and blocks the next station. A robot that was on its way
   * somewhere keeps that trip at the front of its queue and resumes it once
   * it has stepped aside. Returns true if it moved. */
  _stepAside(robot, keepClear) {
    const spot = this._findYieldSpot(robot, keepClear);
    if (!spot) return false;

    this._requeueCurrentTask(robot);
    robot.path = spot.path;
    robot.pathIndex = 0;
    robot.currentTask = spot.cell;
    robot.yielding = true;
    this._setStatus(robot, STATUSES.MOVING);
    return true;
  }

  /** Breadth-first search out from `robot`'s cell, through free walkable
   * cells, scoring every reachable cell outside `keepClear` (see
   * _stepAside). Returns `{ cell, path }` (path excludes the start cell),
   * or null if nothing within YIELD_SEARCH_RADIUS qualifies. */
  _findYieldSpot(robot, keepClear) {
    const grid = this._effectiveGrid();
    const occupied = new Set();
    const onOtherRoutes = new Set();
    for (const other of this.robots.values()) {
      if (other.id === robot.id) continue;
      occupied.add(cellKey(other.currentCell));
      if (other.status !== STATUSES.MOVING || !other.path) continue;
      for (let i = other.pathIndex; i < other.path.length; i++) onOtherRoutes.add(cellKey(other.path[i]));
    }
    const isStation = (c) => this.grid.isCharging(c.x, c.y) || Boolean(this.grid.isDock?.(c.x, c.y));

    const start = robot.currentCell;
    const parents = new Map([[cellKey(start), null]]);
    let frontier = [start];
    let best = null;

    for (let depth = 1; depth <= YIELD_SEARCH_RADIUS && frontier.length > 0; depth++) {
      const next = [];
      for (const cell of frontier) {
        for (const { dx, dy } of ORTHOGONAL_STEPS) {
          const candidate = { x: cell.x + dx, y: cell.y + dy };
          const key = cellKey(candidate);
          if (parents.has(key) || occupied.has(key) || !isWalkable(grid, candidate.x, candidate.y)) continue;
          parents.set(key, cell);
          next.push(candidate);
          if (keepClear.has(key)) continue;
          const score = depth + (onOtherRoutes.has(key) ? 4 : 0) + (isStation(candidate) ? 6 : 0);
          if (!best || score < best.score) best = { cell: candidate, score };
        }
      }
      frontier = next;
    }

    return best ? { cell: best.cell, path: this._pathFromParents(parents, best.cell) } : null;
  }

  /** Puts an interrupted destination back at the front of the queue so the
   * trip resumes later - unless the robot was only stepping aside, in which
   * case there is nothing to resume. */
  _requeueCurrentTask(robot) {
    if (robot.currentTask && !robot.yielding) robot.taskQueue.unshift(robot.currentTask);
    robot.currentTask = null;
    robot.yielding = false;
  }

  _pathFromParents(parents, end) {
    const path = [];
    for (let cell = end; parents.get(cellKey(cell)); cell = parents.get(cellKey(cell))) path.unshift(cell);
    return path;
  }

  /** True if any cell still ahead on this robot's current path is now
   * covered by a dynamic obstacle, or occupied by a broken-down (`error`
   * state) robot - the cases that warrant rerouting immediately rather
   * than waiting, since neither is expected to clear on its own. */
  _hasHazardOnPath(robot) {
    if (!robot.path) return false;
    for (let i = robot.pathIndex; i < robot.path.length; i++) {
      const cell = robot.path[i];
      if (this.dynamicObstacles.isBlocked(cell.x, cell.y)) return true;
      const occupantId = this._occupantOf(cell, robot.id);
      if (occupantId) {
        const occupant = this.robots.get(occupantId);
        if (occupant?.status === STATUSES.ERROR) return true;
      }
    }
    return false;
  }

  /** Recomputes this robot's path to its current destination, avoiding
   * every other robot's current cell and every active dynamic obstacle.
   * Returns true if a new route was found and applied. */
  _rerouteAroundHazards(robot) {
    const destination = robot.currentTask;
    if (!destination) return false;

    const result = findPath(this._gridAvoidingRobotsAndObstacles(robot.id), robot.currentCell, destination);
    if (!result.found) return false;

    const waypoints = result.path.slice(1);
    if (waypoints.length === 0) return false; // already there somehow

    robot.path = waypoints;
    robot.pathIndex = 0;
    return true;
  }

  /** Returns the id of whichever *other* robot currently occupies `cell`,
   * or null if it's free. This shared visibility across every robot in
   * `this.robots` is the "robot communication" this milestone asks for -
   * see the class doc comment. */
  _occupantOf(cell, exceptRobotId) {
    for (const other of this.robots.values()) {
      if (other.id === exceptRobotId) continue;
      if (other.currentCell.x === cell.x && other.currentCell.y === cell.y) return other.id;
    }
    return null;
  }

  /** The static grid plus every currently-active dynamic obstacle - what
   * initial task planning (and spawn/destination validation) treats as
   * blocked. Doesn't include other robots - see the class doc comment on
   * why that's checked reactively during movement instead. */
  _effectiveGrid() {
    const grid = this.grid;
    const dynamicObstacles = this.dynamicObstacles;
    return {
      rows: grid.rows,
      cols: grid.cols,
      isBlocked(x, y) {
        return grid.isBlocked(x, y) || dynamicObstacles.isBlocked(x, y);
      },
      isCharging(x, y) {
        return grid.isCharging(x, y);
      },
    };
  }

  /** The effective grid, plus every other robot's current cell blocked as
   * a temporary obstacle too - what dynamic rerouting plans against. */
  _gridAvoidingRobotsAndObstacles(exceptRobotId) {
    const effectiveGrid = this._effectiveGrid();
    const occupied = new Set();
    for (const other of this.robots.values()) {
      if (other.id === exceptRobotId) continue;
      occupied.add(`${other.currentCell.x}:${other.currentCell.y}`);
    }
    return {
      rows: effectiveGrid.rows,
      cols: effectiveGrid.cols,
      isBlocked(x, y) {
        return effectiveGrid.isBlocked(x, y) || occupied.has(`${x}:${y}`);
      },
    };
  }

  /** Returns false if the robot ran out of battery (and was stopped). */
  _drainBattery(robot, distance) {
    const drain = distance * BATTERY_DRAIN_PER_CELL;
    if (drain >= robot.battery) {
      robot.battery = 0;
      this._setStatus(robot, STATUSES.ERROR);
      robot.errorReason = 'Battery depleted';
      robot.pendingCharge = false;
      // Starts the clock on maintenance retrieval - see _recoverStranded.
      robot.strandedTicks = 0;
      // Park on the last fully-entered cell rather than freezing part-way
      // between two. A fractional resting position is not a cell any other
      // robot's collision check or any later A* plan can reason about -
      // see the note in _tryStartNextTask.
      robot.position = { x: robot.currentCell.x, y: robot.currentCell.y };
      // Put the interrupted destination back at the front of the queue so
      // it resumes automatically once the robot is recharged and cleared.
      this._requeueCurrentTask(robot);
      robot.path = null;
      robot.pathIndex = 0;
      return false;
    }
    robot.battery -= drain;
    return true;
  }

  _snapshot(robot) {
    return {
      id: robot.id,
      name: robot.name,
      position: clonePoint(robot.position),
      rotation: robot.rotation,
      speed: robot.speed,
      battery: robot.battery,
      status: robot.status,
      isWaiting: robot.waitingTicks > 0,
      currentTask: clonePoint(robot.currentTask),
      taskQueue: robot.taskQueue.map(clonePoint),
      errorReason: robot.errorReason,
    };
  }
}

module.exports = {
  RobotEngine,
  STATUSES,
  DEFAULT_SPEED,
  BATTERY_DRAIN_PER_CELL,
  CHARGE_RATE_PER_SECOND,
  DEADLOCK_REROUTE_THRESHOLD,
  LOW_BATTERY_THRESHOLD,
  AUTO_CHARGE_RETRY_TICKS,
  MAX_TASK_QUEUE,
  BATTERY_RESERVE_PERCENT,
  STRANDED_RECOVERY_TICKS,
};

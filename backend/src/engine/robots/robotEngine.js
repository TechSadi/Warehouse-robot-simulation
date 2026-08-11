const { findPath } = require('../pathfinding/astar');
const RobotEngineError = require('./robotEngineError');
const { DynamicObstacleManager } = require('../obstacles/dynamicObstacles');

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
const EPSILON = 1e-9;

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
  constructor(grid) {
    this.grid = grid;
    this.robots = new Map();
    this.dynamicObstacles = new DynamicObstacleManager();
    // Computed once - the grid is read-only for this engine's lifetime
    // (see the class doc comment above), so there's no need to rescan it
    // on every low-battery robot's every tick.
    this._chargingCells = this._scanChargingCells();
  }

  /** Registers a new robot at `position` and returns its initial state. */
  spawnRobot({ id, name, position, speed = DEFAULT_SPEED, battery = 100 }) {
    if (!id) throw new RobotEngineError('INVALID_ARGUMENT', 'spawnRobot requires an id');
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
    };
    this.robots.set(id, robot);
    return this._snapshot(robot);
  }

  /** Removes a robot. Returns true if it existed. */
  removeRobot(id) {
    return this.robots.delete(id);
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
    if (!isWalkable(this._effectiveGrid(), destination.x, destination.y)) {
      throw new RobotEngineError('UNWALKABLE_POSITION', `Destination (${destination.x}, ${destination.y}) is not walkable`);
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
    if (!this.grid.isCharging(robot.position.x, robot.position.y)) {
      throw new RobotEngineError('NOT_AT_CHARGING_STATION', 'Robot must be on a charging cell to charge');
    }
    robot.status = STATUSES.CHARGING;
    robot.errorReason = null;
    return this._snapshot(robot);
  }

  /** Recovers a robot from the error state (e.g. after manual intervention
   * or moving it back onto a charging station). Re-attempts any queued task. */
  clearError(id) {
    const robot = this._requireRobot(id);
    if (robot.status !== STATUSES.ERROR) return this._snapshot(robot);
    robot.status = STATUSES.IDLE;
    robot.errorReason = null;
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
    robot.status = STATUSES.ERROR;
    robot.errorReason = reason;
    if (robot.currentTask) robot.taskQueue.unshift(robot.currentTask);
    robot.currentTask = null;
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
        if (this._hasHazardOnPath(robot)) this._rerouteAroundHazards(robot);
        if (this._advance(robot, deltaSeconds)) changed.push(this._snapshot(robot));
      } else if (robot.status === STATUSES.CHARGING) {
        this._charge(robot, deltaSeconds);
        changed.push(this._snapshot(robot));
      } else if (robot.status === STATUSES.IDLE) {
        if (this._maybeAutoCharge(robot)) changed.push(this._snapshot(robot));
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

  _charge(robot, deltaSeconds) {
    robot.battery = Math.min(100, robot.battery + CHARGE_RATE_PER_SECOND * deltaSeconds);
    if (robot.battery >= 100) {
      robot.status = STATUSES.IDLE;
      this._tryStartNextTask(robot);
    }
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

    if (this.grid.isCharging(robot.position.x, robot.position.y)) {
      robot.status = STATUSES.CHARGING;
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
    return this._tryStartNextTask(robot);
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

  /** Pops the next queued destination (if any) and computes a path to it.
   * Returns true if the robot is now moving. */
  _tryStartNextTask(robot) {
    if (robot.taskQueue.length === 0) return false;
    if (robot.battery <= 0) return false; // stay idle; can't move with no charge

    const destination = robot.taskQueue.shift();
    const result = findPath(this._effectiveGrid(), robot.position, destination);

    if (!result.found) {
      robot.status = STATUSES.ERROR;
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
    robot.status = STATUSES.MOVING;
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
        robot.path = null;
        robot.pathIndex = 0;
        robot.currentTask = null;
        if (!this._tryStartNextTask(robot)) {
          if (robot.status === STATUSES.MOVING) robot.status = STATUSES.IDLE;
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
        if (!this._handleBlocked(robot)) break; // still blocked - hold position
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
   * if it should just keep waiting. */
  _handleBlocked(robot) {
    robot.waitingTicks += 1;
    if (robot.waitingTicks < DEADLOCK_REROUTE_THRESHOLD) return false;

    const rerouted = this._rerouteAroundHazards(robot);
    // Reset the counter either way - whether or not this attempt worked,
    // give it a fresh threshold's worth of ticks before trying again,
    // rather than re-running A* every single tick while stuck.
    robot.waitingTicks = 0;
    return rerouted;
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
      robot.status = STATUSES.ERROR;
      robot.errorReason = 'Battery depleted';
      // Put the interrupted destination back at the front of the queue so
      // it resumes automatically once the robot is recharged and cleared.
      if (robot.currentTask) robot.taskQueue.unshift(robot.currentTask);
      robot.currentTask = null;
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
};

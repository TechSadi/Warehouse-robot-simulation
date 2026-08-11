const RobotEngineError = require('../robots/robotEngineError');

const OBSTACLE_TYPES = ['human_worker', 'temporary_obstacle', 'broken_robot', 'construction_zone'];

function cloneCells(cells) {
  return cells.map((c) => ({ x: c.x, y: c.y }));
}

/**
 * Tracks runtime-only obstacles layered on top of a warehouse's static
 * grid: human workers, temporary obstacles, construction zones, and (as a
 * type, for bookkeeping/reporting) broken robots - though a broken robot
 * blocking its own cell is already handled by the Robot Engine's normal
 * collision logic once it's in the `error` state; this manager doesn't
 * need to duplicate that.
 *
 * Pure and storage-agnostic like every other engine layer: no Mongo, no
 * timers - `tick(deltaSeconds)` is called explicitly by whoever is
 * already ticking the simulation.
 */
class DynamicObstacleManager {
  constructor() {
    this.obstacles = new Map();
  }

  add({ id, type, cells, durationSeconds = null }) {
    if (!id) throw new RobotEngineError('INVALID_ARGUMENT', 'addObstacle requires an id');
    if (this.obstacles.has(id)) {
      throw new RobotEngineError('DUPLICATE_OBSTACLE', `An obstacle with id "${id}" already exists`);
    }
    if (!OBSTACLE_TYPES.includes(type)) {
      throw new RobotEngineError('INVALID_ARGUMENT', `type must be one of: ${OBSTACLE_TYPES.join(', ')}`);
    }
    if (!Array.isArray(cells) || cells.length === 0) {
      throw new RobotEngineError('INVALID_ARGUMENT', 'cells must be a non-empty array of {x, y} points');
    }

    const obstacle = {
      id,
      type,
      cells: cloneCells(cells),
      remainingSeconds: durationSeconds === null ? null : Number(durationSeconds),
    };
    this.obstacles.set(id, obstacle);
    return this._snapshot(obstacle);
  }

  remove(id) {
    return this.obstacles.delete(id);
  }

  get(id) {
    const obstacle = this.obstacles.get(id);
    return obstacle ? this._snapshot(obstacle) : null;
  }

  getAll() {
    return Array.from(this.obstacles.values(), (o) => this._snapshot(o));
  }

  isBlocked(x, y) {
    for (const obstacle of this.obstacles.values()) {
      if (obstacle.cells.some((c) => c.x === x && c.y === y)) return true;
    }
    return false;
  }

  /** Decrements every timed obstacle's remaining duration and removes any
   * that just expired. Obstacles created with no durationSeconds are
   * permanent until explicitly removed. Returns the list of ids that
   * expired this call. */
  tick(deltaSeconds) {
    const expired = [];
    for (const obstacle of this.obstacles.values()) {
      if (obstacle.remainingSeconds === null) continue;
      obstacle.remainingSeconds -= deltaSeconds;
      if (obstacle.remainingSeconds <= 0) expired.push(obstacle.id);
    }
    for (const id of expired) this.obstacles.delete(id);
    return expired;
  }

  _snapshot(obstacle) {
    return {
      id: obstacle.id,
      type: obstacle.type,
      cells: cloneCells(obstacle.cells),
      remainingSeconds: obstacle.remainingSeconds,
    };
  }
}

module.exports = { DynamicObstacleManager, OBSTACLE_TYPES };

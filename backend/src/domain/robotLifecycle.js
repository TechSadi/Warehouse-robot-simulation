/**
 * The robot lifecycle, as one authoritative state machine.
 *
 *   idle <-> moving        (a task is assigned / the path completes)
 *   idle <-> charging      (only while standing on a charging cell)
 *   * -> error             (flat battery, unreachable destination, breakdown)
 *   error -> idle          (only via clearError)
 *
 * RobotEngine already enforced these rules for the simulation, but
 * `PUT /api/robots/:id` wrote `status` straight through to Mongo, so a
 * client could park a moving robot in `charging` mid-aisle, revive a
 * broken robot without clearing the fault, or set `battery: 100` on a
 * robot that had just run flat. The persisted document and the live engine
 * would then disagree, and the engine loses - it reloads from Mongo on the
 * next cache miss.
 *
 * The fix has two halves. This module states the rules once, for both
 * callers. The REST DTO (controllers/robot.controller.js) additionally
 * refuses to write physical state at all: position, rotation, battery and
 * status are simulation-owned and only reachable through the endpoints
 * that go via the engine - POST :id/tasks, :id/charge, :id/clear-error,
 * :id/break.
 */

const STATUSES = ['idle', 'moving', 'charging', 'error'];

const TRANSITIONS = {
  // A robot cannot go straight from idle to moving by fiat - it needs a
  // task, which is what produces the transition. Listed here because the
  // engine performs it; the REST layer cannot request it directly.
  idle: ['moving', 'charging', 'error'],
  // Deliberately no `moving -> charging`: a robot has to stop on a
  // charging cell first. This mirrors RobotEngine.startCharging's own
  // INVALID_TRANSITION guard.
  moving: ['idle', 'error'],
  charging: ['idle', 'error'],
  error: ['idle'],
};

/** Physical/simulation-owned fields. Never client-writable through a
 * generic CRUD route - see the DTO in robot.controller.js. */
const SIMULATION_OWNED_FIELDS = ['position', 'rotation', 'battery', 'status', 'errorReason', 'taskQueue'];

class RobotTransitionError extends Error {
  constructor(from, to) {
    super(`Invalid robot status transition: ${from} -> ${to}`);
    this.name = 'RobotTransitionError';
    this.code = 'INVALID_ROBOT_TRANSITION';
    this.from = from;
    this.to = to;
  }
}

function canTransition(from, to) {
  if (from === to) return true;
  return (TRANSITIONS[from] || []).includes(to);
}

function assertTransition(from, to) {
  if (!STATUSES.includes(to)) throw new RobotTransitionError(from, to);
  if (!canTransition(from, to)) throw new RobotTransitionError(from, to);
}

module.exports = {
  STATUSES,
  TRANSITIONS,
  SIMULATION_OWNED_FIELDS,
  RobotTransitionError,
  canTransition,
  assertTransition,
};

/**
 * The order lifecycle, as one authoritative state machine.
 *
 *   pending -> assigned -> picking_up -> picked_up -> delivering -> delivered
 *
 * with `cancelled` reachable from any non-terminal state, and `delivered`
 * / `cancelled` terminal.
 *
 * This module exists because the REST API and the simulation engine used
 * to disagree about what an order was allowed to do. `PUT /api/orders/:id`
 * accepted any value the schema enum permitted, so a client could move an
 * order straight from `pending` to `delivered` - inventing a completed
 * delivery that no robot ever made, corrupting the statistics derived from
 * it - or resurrect a delivered order back to `pending`. A generic CRUD
 * endpoint must not be a side door around the business rules the engine
 * enforces, so both paths now transition through `assertTransition` here.
 *
 * Note on the two "express" edges (`assigned -> picked_up` and
 * `picked_up -> delivered`): the simulation's OrderCoordinator observes a
 * robot only at the moment it *arrives* somewhere, so it advances an order
 * a full leg at a time rather than through the in-transit sub-states. Both
 * are forward moves along the same chain, so they are legal edges here;
 * `picking_up` and `delivering` remain available to API clients driving an
 * order manually, and every backwards or skip-ahead move is rejected.
 */

const STATUSES = [
  'pending',
  'assigned',
  'picking_up',
  'picked_up',
  'delivering',
  'delivered',
  'cancelled',
];

const TERMINAL_STATUSES = ['delivered', 'cancelled'];

const TRANSITIONS = {
  pending: ['assigned', 'cancelled'],
  // Back to `pending` is an explicit un-assign (the robot broke down, or a
  // dispatch is being undone) - a legal move, not a rewind of history.
  assigned: ['picking_up', 'picked_up', 'pending', 'cancelled'],
  picking_up: ['picked_up', 'pending', 'cancelled'],
  picked_up: ['delivering', 'delivered', 'cancelled'],
  delivering: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: [],
};

/** Timestamps are derived from the transition, never accepted from the
 * client - see the order DTO. An order's `deliveredAt` is a fact about
 * when the server observed the delivery. */
const STATUS_TIMESTAMP_FIELD = {
  assigned: 'assignedAt',
  picked_up: 'pickedUpAt',
  delivered: 'deliveredAt',
};

class OrderTransitionError extends Error {
  constructor(from, to) {
    super(
      TERMINAL_STATUSES.includes(from)
        ? `Order is already ${from} and cannot change status`
        : `Invalid order status transition: ${from} -> ${to}`
    );
    this.name = 'OrderTransitionError';
    this.code = 'INVALID_ORDER_TRANSITION';
    this.from = from;
    this.to = to;
  }
}

function canTransition(from, to) {
  if (from === to) return true; // a no-op write is not an invalid transition
  return (TRANSITIONS[from] || []).includes(to);
}

function assertTransition(from, to) {
  if (!STATUSES.includes(to)) throw new OrderTransitionError(from, to);
  if (!canTransition(from, to)) throw new OrderTransitionError(from, to);
}

/**
 * Validates a status change and returns the fields the server must write
 * alongside it (the transition's timestamp, and the assignment fields a
 * requeue has to clear). Returns `{}` for a no-op.
 */
function buildTransitionUpdate(from, to, { now = new Date() } = {}) {
  assertTransition(from, to);
  if (from === to) return {};

  const update = { status: to };

  const timestampField = STATUS_TIMESTAMP_FIELD[to];
  if (timestampField) update[timestampField] = now;

  // Un-assigning has to release the robot and clear the assignment
  // timestamp, or the order keeps pointing at a robot that is no longer
  // working it and the dispatcher double-books.
  if (to === 'pending') {
    update.assignedRobot = null;
    update.assignedAt = null;
  }

  return update;
}

function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Every state a legal transition into `to` can start from.
 *
 * This is what lets the simulation enforce the same rules atomically. The
 * engine's tick path writes with `Order.bulkWrite`, where a read-check-write
 * would race the REST API editing the same order; instead the update carries
 * `status: { $in: predecessorsOf(next) }` in its filter, so an illegal move
 * simply matches no document rather than being applied and then noticed.
 */
function predecessorsOf(to) {
  return Object.keys(TRANSITIONS).filter((from) => TRANSITIONS[from].includes(to));
}

module.exports = {
  STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  STATUS_TIMESTAMP_FIELD,
  OrderTransitionError,
  canTransition,
  assertTransition,
  buildTransitionUpdate,
  isTerminal,
  predecessorsOf,
};

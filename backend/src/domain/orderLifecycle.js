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

/**
 * Every state in which an order is the responsibility of some robot. These
 * are exactly the states whose progress depends on runtime state that does
 * not survive a restart or an engine reload (the OrderCoordinator's
 * in-memory assignment map), so they are also exactly the states the
 * recovery path has to requeue - see
 * `simulationManager.reconcileWarehouse`.
 */
const IN_FLIGHT_STATUSES = ['assigned', 'picking_up', 'picked_up', 'delivering'];

const TRANSITIONS = {
  pending: ['assigned', 'cancelled'],
  // Back to `pending` is an explicit un-assign (the robot broke down, or a
  // dispatch is being undone) - a legal move, not a rewind of history.
  assigned: ['picking_up', 'picked_up', 'pending', 'cancelled'],
  picking_up: ['picked_up', 'pending', 'cancelled'],
  // `picked_up -> pending` and `delivering -> pending` are the *release*
  // edges, added in the reliability phase. Before them, an order whose
  // robot broke down mid-delivery, or whose runtime assignment was lost to
  // a restart or an engine reload, had nowhere legal to go: it was not
  // terminal, so it stayed `picked_up` forever, pointing at a robot that
  // was no longer carrying it, and the dispatcher (which only ever looks
  // at `pending`) could never pick it up again. Returning it to the
  // dispatchable pool is a release of a claim, not a rewind of a delivery
  // - `deliveredAt` is only ever written by an actual delivery, and
  // `delivered` remains terminal and unreachable from here.
  picked_up: ['delivering', 'delivered', 'pending', 'cancelled'],
  delivering: ['delivered', 'pending', 'cancelled'],
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
    // A released order has not been picked up by anyone any more: leaving
    // `pickedUpAt` set would have the next robot's delivery report a
    // pickup that happened before it was even assigned.
    update.pickedUpAt = null;
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
  IN_FLIGHT_STATUSES,
  TRANSITIONS,
  STATUS_TIMESTAMP_FIELD,
  OrderTransitionError,
  canTransition,
  assertTransition,
  buildTransitionUpdate,
  isTerminal,
  predecessorsOf,
};

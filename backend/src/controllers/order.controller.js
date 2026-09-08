const Order = require('../models/Order');
const Robot = require('../models/Robot');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');
const { pick } = require('../middleware/dto');
const { buildTransitionUpdate, isTerminal } = require('../domain/orderLifecycle');
const simulationEvents = require('../events/simulationEvents');

/**
 * A new order describes *what* is to be moved, never how far along it is.
 * `status` is absent: every order starts `pending` and advances through
 * the lifecycle (domain/orderLifecycle.js). Accepting it here would let a
 * client POST an order that was already `delivered`, inventing a
 * completed delivery that no robot ever made - and every statistic
 * derived from the orders collection inherits that lie.
 *
 * `assignedRobot` and the `*At` timestamps are absent for the same
 * reason: they are facts the server observes, not claims the client makes.
 */
const CREATE_FIELDS = ['warehouseId', 'pickupLocation', 'deliveryLocation', 'priority'];

/** Only the fields that are still meaningfully editable. Locations are
 * included but guarded below - moving the pickup point of an order a robot
 * is already driving to would strand it. */
const UPDATE_FIELDS = ['pickupLocation', 'deliveryLocation', 'priority'];

const PROTECTED_FIELDS = ['warehouseId', 'assignedAt', 'pickedUpAt', 'deliveredAt', '_id', 'createdAt'];
// On create the client does name its warehouse - requireWarehouseBody has
// already proved it owns that one - so only the rest are off limits.
const CREATE_PROTECTED_FIELDS = PROTECTED_FIELDS.filter((f) => f !== 'warehouseId');

function assertPointInBounds(warehouse, point, label) {
  if (!point) return;
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.y < 0 ||
    point.x >= warehouse.cols ||
    point.y >= warehouse.rows
  ) {
    throw new ApiError(422, `${label} is outside the warehouse bounds`);
  }
}

function rejectProtectedFields(body, protectedFields = PROTECTED_FIELDS) {
  const attempted = protectedFields.filter((f) => Object.prototype.hasOwnProperty.call(body || {}, f));
  if (attempted.length === 0) return;
  throw new ApiError(422, `These fields are server-owned and cannot be set: ${attempted.join(', ')}`, {
    fields: attempted,
  });
}

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { ...req.ownershipFilter };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.priority) filter.priority = req.query.priority;

  const [items, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Order.countDocuments(filter),
  ]);

  res.json({ success: true, data: items, meta: buildMeta({ page, limit, total }) });
});

const getOne = asyncHandler(async (req, res) => {
  res.json({ success: true, data: req.resource });
});

const create = asyncHandler(async (req, res) => {
  rejectProtectedFields(req.body, CREATE_PROTECTED_FIELDS);
  if (Object.prototype.hasOwnProperty.call(req.body, 'status')) {
    throw new ApiError(422, 'New orders always start as "pending"; use PUT /api/orders/:id to advance one.');
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'assignedRobot')) {
    throw new ApiError(422, 'assignedRobot is set by dispatch, not by the client.');
  }

  const warehouse = req.warehouse; // ownership-checked by requireWarehouseBody
  const payload = pick(req.body, CREATE_FIELDS);
  payload.warehouseId = warehouse._id;

  assertPointInBounds(warehouse, payload.pickupLocation, 'pickupLocation');
  assertPointInBounds(warehouse, payload.deliveryLocation, 'deliveryLocation');

  const order = await Order.create(payload);
  simulationEvents.emit('orders:changed', { warehouseId: String(warehouse._id), reason: 'created' });
  res.status(201).json({ success: true, data: order });
});

/**
 * The generic CRUD update, now routed through the same state machine the
 * simulation engine obeys.
 *
 * Previously this took whatever `status` the schema enum allowed and wrote
 * it: `pending -> delivered` in one hop, or `delivered -> pending` to
 * un-deliver a finished order, were both accepted. Now every status change
 * is checked against domain/orderLifecycle.js, and the timestamp each
 * transition implies is written by the server rather than trusted from the
 * body.
 */
const update = asyncHandler(async (req, res) => {
  rejectProtectedFields(req.body);

  const order = req.resource; // ownership-checked by requireOwnedResource
  const warehouse = req.warehouse;
  const payload = pick(req.body, UPDATE_FIELDS);

  assertPointInBounds(warehouse, payload.pickupLocation, 'pickupLocation');
  assertPointInBounds(warehouse, payload.deliveryLocation, 'deliveryLocation');

  // Editing the route of an order already in flight desynchronises the
  // order from the path the robot is actually driving.
  const editsLocation = payload.pickupLocation !== undefined || payload.deliveryLocation !== undefined;
  if (editsLocation && order.status !== 'pending') {
    throw new ApiError(409, 'Pickup and delivery locations can only be changed while an order is pending');
  }

  if (isTerminal(order.status) && Object.keys(payload).length > 0) {
    throw new ApiError(409, `Order is already ${order.status} and can no longer be modified`);
  }

  const update$ = { ...payload };

  if (req.body.status !== undefined) {
    // Throws OrderTransitionError (mapped to 409 in errorHandler) on an
    // illegal move, and returns the server-owned timestamp fields.
    Object.assign(update$, buildTransitionUpdate(order.status, req.body.status));
  }

  if (req.body.assignedRobot !== undefined) {
    Object.assign(update$, await resolveAssignedRobot(req.body.assignedRobot, warehouse));
  }

  if (Object.keys(update$).length === 0) {
    return res.json({ success: true, data: order });
  }

  const updated = await Order.findByIdAndUpdate(
    order._id,
    { $set: update$ },
    { new: true, runValidators: true, context: 'query' }
  );
  if (!updated) throw new ApiError(404, 'Order not found');

  simulationEvents.emit('orders:changed', { warehouseId: String(warehouse._id), reason: 'updated' });
  res.json({ success: true, data: updated });
});

/** A robot may only be attached to an order in the same warehouse -
 * otherwise an order becomes a way to reference (and, through the orders
 * list, to discover) a robot in someone else's simulation. */
async function resolveAssignedRobot(assignedRobot, warehouse) {
  if (assignedRobot === null) return { assignedRobot: null };

  const robot = await Robot.findOne({ _id: assignedRobot, warehouseId: warehouse._id }).select('_id');
  if (!robot) throw new ApiError(422, 'assignedRobot must be a robot in this warehouse');
  return { assignedRobot: robot._id };
}

const remove = asyncHandler(async (req, res) => {
  const order = await Order.findByIdAndDelete(req.resource._id);
  if (!order) throw new ApiError(404, 'Order not found');
  simulationEvents.emit('orders:changed', {
    warehouseId: String(order.warehouseId),
    reason: 'deleted',
  });
  res.status(204).send();
});

module.exports = { list, getOne, create, update, remove };

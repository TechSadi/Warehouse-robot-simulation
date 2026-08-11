const Order = require('../models/Order');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');

// Milestone 6 (Order Management) owns the actual assignment/pickup workflow;
// this just makes sure the timestamp a status transition implies is never
// forgotten by a caller, whether that caller is Milestone 6's scheduler or
// someone testing the API by hand.
const STATUS_TIMESTAMP_FIELD = {
  assigned: 'assignedAt',
  picked_up: 'pickedUpAt',
  delivered: 'deliveredAt',
};

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.warehouseId) filter.warehouseId = req.query.warehouseId;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.priority) filter.priority = req.query.priority;

  const [items, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Order.countDocuments(filter),
  ]);

  res.json({ success: true, data: items, meta: buildMeta({ page, limit, total }) });
});

const getOne = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new ApiError(404, 'Order not found');
  res.json({ success: true, data: order });
});

const create = asyncHandler(async (req, res) => {
  const order = await Order.create(req.body);
  res.status(201).json({ success: true, data: order });
});

const update = asyncHandler(async (req, res) => {
  const payload = { ...req.body };
  const timestampField = STATUS_TIMESTAMP_FIELD[payload.status];
  if (timestampField && payload[timestampField] === undefined) {
    payload[timestampField] = new Date();
  }

  const order = await Order.findByIdAndUpdate(req.params.id, payload, {
    new: true,
    runValidators: true,
    context: 'query',
  });
  if (!order) throw new ApiError(404, 'Order not found');
  res.json({ success: true, data: order });
});

const remove = asyncHandler(async (req, res) => {
  const order = await Order.findByIdAndDelete(req.params.id);
  if (!order) throw new ApiError(404, 'Order not found');
  res.status(204).send();
});

module.exports = { list, getOne, create, update, remove };

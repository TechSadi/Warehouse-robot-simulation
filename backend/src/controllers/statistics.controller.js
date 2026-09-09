const Statistics = require('../models/Statistics');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');
const { pick } = require('../middleware/dto');

/**
 * `recordedAt` is deliberately absent: a snapshot's timestamp is when the
 * server recorded it. Letting a client choose it means backdating metrics
 * into another period's chart, or planting a future-dated point that
 * distorts every rolling average after it. `metrics` is allowed but
 * projected field by field below, so an unknown sub-key cannot ride along.
 */
const CREATE_FIELDS = ['warehouseId', 'metrics'];
const METRIC_FIELDS = [
  'activeRobots',
  'idleRobots',
  'pendingOrders',
  'completedOrders',
  'avgBattery',
  'deliveriesPerHour',
];

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = { ...req.ownershipFilter };

  if (req.query.from || req.query.to) {
    filter.recordedAt = {};
    if (req.query.from) filter.recordedAt.$gte = new Date(req.query.from);
    if (req.query.to) filter.recordedAt.$lte = new Date(req.query.to);
  }

  const [items, total] = await Promise.all([
    Statistics.find(filter).sort({ recordedAt: -1 }).skip(skip).limit(limit),
    Statistics.countDocuments(filter),
  ]);

  res.json({ success: true, data: items, meta: buildMeta({ page, limit, total }) });
});

const getOne = asyncHandler(async (req, res) => {
  res.json({ success: true, data: req.resource });
});

const create = asyncHandler(async (req, res) => {
  if (Object.prototype.hasOwnProperty.call(req.body, 'recordedAt')) {
    throw new ApiError(422, 'recordedAt is set by the server and cannot be supplied by the client');
  }

  const payload = pick(req.body, CREATE_FIELDS);
  payload.warehouseId = req.warehouse._id; // ownership-checked by requireWarehouseBody
  payload.metrics = pick(payload.metrics, METRIC_FIELDS);

  const snapshot = await Statistics.create(payload);
  res.status(201).json({ success: true, data: snapshot });
});

const remove = asyncHandler(async (req, res) => {
  const snapshot = await Statistics.findByIdAndDelete(req.resource._id);
  if (!snapshot) throw new ApiError(404, 'Statistics snapshot not found');
  res.status(204).send();
});

module.exports = { list, getOne, create, remove };

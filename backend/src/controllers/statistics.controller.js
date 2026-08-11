const Statistics = require('../models/Statistics');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.warehouseId) filter.warehouseId = req.query.warehouseId;
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
  const snapshot = await Statistics.findById(req.params.id);
  if (!snapshot) throw new ApiError(404, 'Statistics snapshot not found');
  res.json({ success: true, data: snapshot });
});

const create = asyncHandler(async (req, res) => {
  const snapshot = await Statistics.create(req.body);
  res.status(201).json({ success: true, data: snapshot });
});

const remove = asyncHandler(async (req, res) => {
  const snapshot = await Statistics.findByIdAndDelete(req.params.id);
  if (!snapshot) throw new ApiError(404, 'Statistics snapshot not found');
  res.status(204).send();
});

module.exports = { list, getOne, create, remove };

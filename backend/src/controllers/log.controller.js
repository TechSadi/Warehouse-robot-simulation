const Log = require('../models/Log');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.warehouseId) filter.warehouseId = req.query.warehouseId;
  if (req.query.level) filter.level = req.query.level;
  if (req.query.source) filter.source = req.query.source;

  const [items, total] = await Promise.all([
    Log.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Log.countDocuments(filter),
  ]);

  res.json({ success: true, data: items, meta: buildMeta({ page, limit, total }) });
});

const getOne = asyncHandler(async (req, res) => {
  const log = await Log.findById(req.params.id);
  if (!log) throw new ApiError(404, 'Log entry not found');
  res.json({ success: true, data: log });
});

const create = asyncHandler(async (req, res) => {
  const log = await Log.create(req.body);
  res.status(201).json({ success: true, data: log });
});

const remove = asyncHandler(async (req, res) => {
  const log = await Log.findByIdAndDelete(req.params.id);
  if (!log) throw new ApiError(404, 'Log entry not found');
  res.status(204).send();
});

module.exports = { list, getOne, create, remove };

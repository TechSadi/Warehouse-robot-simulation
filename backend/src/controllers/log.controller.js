const Log = require('../models/Log');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');
const { pick } = require('../middleware/dto');

/**
 * A client-written log entry must be attributable. `source` is absent from
 * the allow-list and pinned to `client` below: without that, a caller
 * could post entries claiming to come from `robot-engine` or
 * `order-service`, i.e. forge the audit trail the Logs panel presents as
 * the system's own account of what happened.
 *
 * `warehouseId` is required (not optional as before) so every user-created
 * log belongs to an owned warehouse - a null-warehouse log is a
 * system-level record, and those are server-authored only.
 */
const CREATE_FIELDS = ['level', 'message', 'warehouseId'];
const CLIENT_SOURCE = 'client';

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  // Scoped to the caller's warehouses. Logs are the richest incidental
  // disclosure surface in the app - they carry other users' warehouse ids,
  // robot ids and order ids in their message text - so an unscoped list
  // here would undo much of the isolation the other endpoints enforce.
  const filter = { ...req.ownershipFilter };
  if (req.query.level) filter.level = req.query.level;
  if (req.query.source) filter.source = req.query.source;

  const [items, total] = await Promise.all([
    Log.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Log.countDocuments(filter),
  ]);

  res.json({ success: true, data: items, meta: buildMeta({ page, limit, total }) });
});

const getOne = asyncHandler(async (req, res) => {
  res.json({ success: true, data: req.resource });
});

const create = asyncHandler(async (req, res) => {
  if (Object.prototype.hasOwnProperty.call(req.body, 'source')) {
    throw new ApiError(422, 'source is assigned by the server and cannot be supplied by the client');
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'meta')) {
    // `meta` is Schema.Types.Mixed - an unvalidated, unbounded object
    // straight into the database. Server-side callers use it; clients do not.
    throw new ApiError(422, 'meta cannot be set by the client');
  }

  const payload = pick(req.body, CREATE_FIELDS);
  payload.warehouseId = req.warehouse._id; // ownership-checked by requireWarehouseBody
  payload.source = CLIENT_SOURCE;

  const log = await Log.create(payload);
  res.status(201).json({ success: true, data: log });
});

const remove = asyncHandler(async (req, res) => {
  const log = await Log.findByIdAndDelete(req.resource._id);
  if (!log) throw new ApiError(404, 'Log entry not found');
  res.status(204).send();
});

module.exports = { list, getOne, create, remove };

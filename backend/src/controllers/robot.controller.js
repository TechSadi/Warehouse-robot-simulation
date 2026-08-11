const Robot = require('../models/Robot');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');
const simulationManager = require('../services/simulationManager');
const simulationEvents = require('../events/simulationEvents');

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.warehouseId) filter.warehouseId = req.query.warehouseId;
  if (req.query.status) filter.status = req.query.status;

  const [items, total] = await Promise.all([
    Robot.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Robot.countDocuments(filter),
  ]);

  res.json({ success: true, data: items, meta: buildMeta({ page, limit, total }) });
});

const getOne = asyncHandler(async (req, res) => {
  const robot = await Robot.findById(req.params.id);
  if (!robot) throw new ApiError(404, 'Robot not found');
  res.json({ success: true, data: robot });
});

const create = asyncHandler(async (req, res) => {
  const robot = await Robot.create(req.body);
  // NOTE: this doesn't add the robot to an already-cached live engine (see
  // simulationManager.getEngine's lazy Mongo load) - a known pre-existing
  // gap, not something Milestone 11 changes. The real-time event still
  // fires so a freshly spawned robot shows up in every connected client's
  // roster immediately; it just won't move until the engine cache is next
  // rebuilt (warehouse update, or server restart).
  simulationEvents.emit('robots:changed', { warehouseId: String(robot.warehouseId), robots: [robot] });
  res.status(201).json({ success: true, data: robot });
});

const update = asyncHandler(async (req, res) => {
  const robot = await Robot.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
    context: 'query',
  });
  if (!robot) throw new ApiError(404, 'Robot not found');
  simulationEvents.emit('robots:changed', { warehouseId: String(robot.warehouseId), robots: [robot] });
  res.json({ success: true, data: robot });
});

const remove = asyncHandler(async (req, res) => {
  const robot = await Robot.findByIdAndDelete(req.params.id);
  if (!robot) throw new ApiError(404, 'Robot not found');
  simulationEvents.emit('robots:removed', { warehouseId: String(robot.warehouseId), robotId: req.params.id });
  res.status(204).send();
});

/** Loads the robot doc and its warehouse's live simulation engine together
 * - every action below needs both. */
async function loadRobotAndEngine(robotId) {
  const doc = await Robot.findById(robotId);
  if (!doc) throw new ApiError(404, 'Robot not found');
  const engine = await simulationManager.getEngine(doc.warehouseId);
  if (!engine) throw new ApiError(404, 'This robot\'s warehouse no longer exists');
  if (!engine.getRobot(robotId)) {
    throw new ApiError(409, 'Robot is not currently loaded in the simulation (its saved position may no longer be walkable)');
  }
  return { doc, engine };
}

function broadcastRobot(doc, snapshot) {
  simulationEvents.emit('robots:changed', { warehouseId: String(doc.warehouseId), robots: [snapshot] });
}

const assignTask = asyncHandler(async (req, res) => {
  const { doc, engine } = await loadRobotAndEngine(req.params.id);
  const snapshot = engine.assignTask(req.params.id, req.body.destination);
  await simulationManager.persistRobot(req.params.id, snapshot);
  broadcastRobot(doc, snapshot);
  res.json({ success: true, data: snapshot });
});

const startCharging = asyncHandler(async (req, res) => {
  const { doc, engine } = await loadRobotAndEngine(req.params.id);
  const snapshot = engine.startCharging(req.params.id);
  await simulationManager.persistRobot(req.params.id, snapshot);
  broadcastRobot(doc, snapshot);
  res.json({ success: true, data: snapshot });
});

const clearError = asyncHandler(async (req, res) => {
  const { doc, engine } = await loadRobotAndEngine(req.params.id);
  const snapshot = engine.clearError(req.params.id);
  await simulationManager.persistRobot(req.params.id, snapshot);
  broadcastRobot(doc, snapshot);
  res.json({ success: true, data: snapshot });
});

const markBroken = asyncHandler(async (req, res) => {
  const { doc, engine } = await loadRobotAndEngine(req.params.id);
  const snapshot = engine.markBroken(req.params.id, req.body.reason);
  await simulationManager.persistRobot(req.params.id, snapshot);
  broadcastRobot(doc, snapshot);
  simulationEvents.emit('notification', {
    warehouseId: String(doc.warehouseId),
    level: 'warn',
    message: `Robot ${req.params.id} marked broken${req.body.reason ? `: ${req.body.reason}` : ''}`,
    timestamp: new Date().toISOString(),
  });
  res.json({ success: true, data: snapshot });
});

module.exports = { list, getOne, create, update, remove, assignTask, startCharging, clearError, markBroken };

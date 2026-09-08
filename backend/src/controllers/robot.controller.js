const Robot = require('../models/Robot');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');
const { pick } = require('../middleware/dto');
const { SIMULATION_OWNED_FIELDS } = require('../domain/robotLifecycle');
const simulationManager = require('../services/simulationManager');
const simulationEvents = require('../events/simulationEvents');

/**
 * Creation may set a robot's *initial* physical placement - that is what
 * spawning one means. Everything after that belongs to the simulation.
 */
const CREATE_FIELDS = ['name', 'warehouseId', 'position', 'speed', 'battery'];

/**
 * Updates may only touch the robot's identity and configuration.
 *
 * `status`, `battery`, `position`, `rotation`, `errorReason` and
 * `taskQueue` are deliberately absent. Writing them here would let a
 * client teleport a robot through a wall, refill a flat battery, clear a
 * fault without addressing it, or park a moving robot in `charging`
 * mid-aisle - each of which desynchronises the persisted document from
 * the live RobotEngine, and the engine loses that argument, because it
 * reloads from Mongo on its next cache miss. Those changes have to go
 * through the endpoints that drive the engine and its own transition
 * rules: POST :id/tasks, :id/charge, :id/clear-error, :id/break.
 *
 * `warehouseId` is absent too: re-parenting a robot into a different
 * warehouse is how a client would smuggle one of its objects into another
 * user's simulation.
 */
const UPDATE_FIELDS = ['name', 'speed'];

/** On create, initial placement and charge level are legitimately the
 * client's to choose; the rest of the physical state still is not. */
const CREATE_PROTECTED_FIELDS = SIMULATION_OWNED_FIELDS.filter(
  (f) => f !== 'position' && f !== 'battery'
);

/** Rejecting an attempt loudly beats silently dropping it - a client that
 * thinks it disabled a robot and got a 200 back is worse off than one that
 * gets told where the real control is. */
function rejectProtectedFields(body, protectedFields = SIMULATION_OWNED_FIELDS) {
  const attempted = protectedFields.filter((f) =>
    Object.prototype.hasOwnProperty.call(body || {}, f)
  );
  if (attempted.length === 0) return;
  throw new ApiError(
    422,
    `Simulation-owned fields cannot be set directly: ${attempted.join(', ')}. ` +
      'Use POST /api/robots/:id/tasks, /charge, /clear-error or /break instead.',
    { fields: attempted }
  );
}

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  // scopeListToOwner built this: either the one warehouse the caller asked
  // for (ownership already checked) or every warehouse the caller owns.
  const filter = { ...req.ownershipFilter };
  if (req.query.status) filter.status = req.query.status;

  const [items, total] = await Promise.all([
    Robot.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Robot.countDocuments(filter),
  ]);

  res.json({ success: true, data: items, meta: buildMeta({ page, limit, total }) });
});

const getOne = asyncHandler(async (req, res) => {
  res.json({ success: true, data: req.resource });
});

const create = asyncHandler(async (req, res) => {
  rejectProtectedFields(req.body, CREATE_PROTECTED_FIELDS);

  const warehouse = req.warehouse; // ownership-checked by requireWarehouseBody
  const payload = pick(req.body, CREATE_FIELDS);
  payload.warehouseId = warehouse._id; // never the raw body value

  const position = payload.position || { x: 0, y: 0 };
  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    position.x < 0 ||
    position.y < 0 ||
    position.x >= warehouse.cols ||
    position.y >= warehouse.rows
  ) {
    throw new ApiError(422, 'position must be inside the warehouse bounds');
  }

  const robot = await Robot.create(payload);
  // create a new robot while simulation is still going on
  simulationManager.addRobotToCachedEngine(robot.warehouseId, robot);
  simulationEvents.emit('robots:changed', { warehouseId: String(robot.warehouseId), robots: [robot] });
  res.status(201).json({ success: true, data: robot });
});

const update = asyncHandler(async (req, res) => {
  rejectProtectedFields(req.body);

  const robot = await Robot.findByIdAndUpdate(
    req.resource._id,
    { $set: pick(req.body, UPDATE_FIELDS) },
    { new: true, runValidators: true, context: 'query' }
  );
  if (!robot) throw new ApiError(404, 'Robot not found');
  simulationEvents.emit('robots:changed', { warehouseId: String(robot.warehouseId), robots: [robot] });
  res.json({ success: true, data: robot });
});

const remove = asyncHandler(async (req, res) => {
  const robot = await Robot.findByIdAndDelete(req.resource._id);
  if (!robot) throw new ApiError(404, 'Robot not found');
  simulationEvents.emit('robots:removed', {
    warehouseId: String(robot.warehouseId),
    robotId: String(robot._id),
  });
  res.status(204).send();
});

/** Loads the ownership-checked robot doc alongside its warehouse's live
 * simulation engine - every action below needs both. */
async function loadEngineFor(doc) {
  const engine = await simulationManager.getEngine(doc.warehouseId);
  if (!engine) throw new ApiError(404, "This robot's warehouse no longer exists");
  if (!engine.getRobot(String(doc._id))) {
    throw new ApiError(
      409,
      'Robot is not currently loaded in the simulation (its saved position may no longer be walkable)'
    );
  }
  return engine;
}

function broadcastRobot(doc, snapshot) {
  simulationEvents.emit('robots:changed', { warehouseId: String(doc.warehouseId), robots: [snapshot] });
}

const assignTask = asyncHandler(async (req, res) => {
  const doc = req.resource;
  const warehouse = req.warehouse;
  const { destination } = req.body;

  if (
    destination.x < 0 ||
    destination.y < 0 ||
    destination.x >= warehouse.cols ||
    destination.y >= warehouse.rows
  ) {
    throw new ApiError(422, 'destination is outside the warehouse bounds');
  }

  const engine = await loadEngineFor(doc);
  const snapshot = engine.assignTask(String(doc._id), destination);
  await simulationManager.persistRobot(doc._id, snapshot);
  broadcastRobot(doc, snapshot);
  res.json({ success: true, data: snapshot });
});

const startCharging = asyncHandler(async (req, res) => {
  const doc = req.resource;
  const engine = await loadEngineFor(doc);
  // The engine owns the transition rules (idle/error -> charging, only on
  // a charging cell) and throws INVALID_TRANSITION otherwise.
  const snapshot = engine.startCharging(String(doc._id));
  await simulationManager.persistRobot(doc._id, snapshot);
  broadcastRobot(doc, snapshot);
  res.json({ success: true, data: snapshot });
});

const clearError = asyncHandler(async (req, res) => {
  const doc = req.resource;
  const engine = await loadEngineFor(doc);
  const snapshot = engine.clearError(String(doc._id));
  await simulationManager.persistRobot(doc._id, snapshot);
  broadcastRobot(doc, snapshot);
  res.json({ success: true, data: snapshot });
});

const markBroken = asyncHandler(async (req, res) => {
  const doc = req.resource;
  const engine = await loadEngineFor(doc);
  const reason = typeof req.body.reason === 'string' ? req.body.reason : undefined;
  const snapshot = engine.markBroken(String(doc._id), reason);
  await simulationManager.persistRobot(doc._id, snapshot);
  broadcastRobot(doc, snapshot);
  simulationEvents.emit('notification', {
    warehouseId: String(doc.warehouseId),
    level: 'warn',
    message: `Robot ${doc._id} marked broken${reason ? `: ${reason}` : ''}`,
    timestamp: new Date().toISOString(),
  });
  res.json({ success: true, data: snapshot });
});

module.exports = { list, getOne, create, update, remove, assignTask, startCharging, clearError, markBroken };

const Robot = require('../models/Robot');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');
const { pick } = require('../middleware/dto');
const { SIMULATION_OWNED_FIELDS } = require('../domain/robotLifecycle');
const simulationManager = require('../services/simulationManager');
const warehouseLock = require('../services/warehouseLock');
const orderService = require('../services/orderService');
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
  // A robot is *placed in a cell*. A fractional starting position is not
  // one, and the engine cannot spawn on it - so accepting it here created
  // a robot that existed in MongoDB and could never join the simulation,
  // which is precisely the desynchronisation this phase is about. A
  // fractional position only ever arises legitimately mid-move, and the
  // simulation owns that.
  if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) {
    throw new ApiError(422, 'position must name a whole cell (integer x and y)');
  }

  const robot = await Robot.create(payload);

  // Registering the robot with the live engine happens inside the
  // warehouse lock, so a robot created while a simulation is running joins
  // the fleet cleanly between two ticks rather than part-way through one -
  // a tick that had already iterated past its insertion point would move
  // every other robot without ever seeing it, including for collision
  // checks. If nothing is loaded for this warehouse yet, there is nothing
  // to join: the next engine load reads it straight from Mongo.
  const snapshot = await warehouseLock.runExclusive(warehouse._id, () =>
    simulationManager.addRobotToCachedEngine(robot.warehouseId, robot)
  );

  simulationEvents.emit('robots:changed', {
    warehouseId: String(robot.warehouseId),
    robots: [snapshot || robot],
  });
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

/**
 * Deleting a robot has to unwind three things, not one.
 *
 * Previously it deleted the MongoDB document and stopped there. The live
 * engine still held the robot: it kept consuming its path, kept occupying
 * (and so blocking) cells for every other robot's collision check, kept
 * being broadcast to clients as part of the fleet, and - if it was
 * mid-order - kept an OrderCoordinator assignment alive that pinned that
 * order in an in-flight state permanently, since only an arrival event
 * from that robot could ever have advanced it. The document was gone and
 * the simulation had not noticed.
 */
const remove = asyncHandler(async (req, res) => {
  const robot = await Robot.findByIdAndDelete(req.resource._id);
  if (!robot) throw new ApiError(404, 'Robot not found');

  const releasedOrderIds = await warehouseLock.runExclusive(robot.warehouseId, () =>
    simulationManager.removeRobotFromCachedEngine(robot.warehouseId, robot._id)
  );
  // Outside the lock: this is Mongo bookkeeping about orders, and it
  // covers both what the coordinator was holding and any order document
  // still naming this robot (e.g. one assigned before a restart).
  await orderService.releaseOrdersForRobot(robot.warehouseId, robot._id, releasedOrderIds);

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

  // Serialized with ticks and dispatch: `assignTask` runs A* against the
  // current grid and fleet, and persists the result - both of which a
  // concurrent tick would be changing underneath it.
  const snapshot = await warehouseLock.runExclusive(doc.warehouseId, async () => {
    const engine = await loadEngineFor(doc);
    const next = engine.assignTask(String(doc._id), destination);
    await simulationManager.persistRobot(doc._id, next);
    return next;
  });
  broadcastRobot(doc, snapshot);
  res.json({ success: true, data: snapshot });
});

const startCharging = asyncHandler(async (req, res) => {
  const doc = req.resource;
  const snapshot = await warehouseLock.runExclusive(doc.warehouseId, async () => {
    const engine = await loadEngineFor(doc);
    // The engine owns the transition rules (idle/error -> charging, only
    // on a charging cell) and throws INVALID_TRANSITION otherwise.
    const next = engine.startCharging(String(doc._id));
    await simulationManager.persistRobot(doc._id, next);
    return next;
  });
  broadcastRobot(doc, snapshot);
  res.json({ success: true, data: snapshot });
});

const clearError = asyncHandler(async (req, res) => {
  const doc = req.resource;
  const snapshot = await warehouseLock.runExclusive(doc.warehouseId, async () => {
    const engine = await loadEngineFor(doc);
    const next = engine.clearError(String(doc._id));
    await simulationManager.persistRobot(doc._id, next);
    return next;
  });
  broadcastRobot(doc, snapshot);
  res.json({ success: true, data: snapshot });
});

const markBroken = asyncHandler(async (req, res) => {
  const doc = req.resource;
  const reason = typeof req.body.reason === 'string' ? req.body.reason : undefined;
  const snapshot = await warehouseLock.runExclusive(doc.warehouseId, async () => {
    const engine = await loadEngineFor(doc);
    const next = engine.markBroken(String(doc._id), reason);
    await simulationManager.persistRobot(doc._id, next);
    return next;
  });
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

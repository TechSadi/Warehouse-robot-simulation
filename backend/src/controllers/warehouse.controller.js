const Warehouse = require('../models/Warehouse');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');
const { pick } = require('../middleware/dto');
const { findPath, findPathWithTrace } = require('../engine/pathfinding/astar');
const { warehouseToGrid } = require('../engine/grid/warehouseGrid');
const simulationManager = require('../services/simulationManager');
const orderService = require('../services/orderService');
const tickRunner = require('../services/tickRunner');
const simulationEvents = require('../events/simulationEvents');

/**
 * Fields a client may set on a warehouse. `ownerId` is conspicuously
 * absent and comes from the authenticated session instead - accepting it
 * from the body would let a caller create a warehouse inside someone
 * else's account. `isActive` is absent too: activation has its own
 * endpoint because it has a side effect on the caller's *other*
 * warehouses, which a plain field write would skip.
 */
const CREATE_FIELDS = ['name', 'rows', 'cols', 'cells', 'schedulingStrategy'];
const UPDATE_FIELDS = ['name', 'rows', 'cols', 'cells', 'schedulingStrategy'];

/** Obstacle fields a client may set. Everything else the engine tracks
 * (creation time, remaining lifetime, derived cell index) is internal. */
const OBSTACLE_FIELDS = ['id', 'type', 'cells', 'durationSeconds'];

/** Coordinates are validated as non-negative numbers by the route, but
 * "non-negative" is not "inside this warehouse" - an out-of-bounds goal
 * would otherwise make A* explore the entire reachable grid before
 * reporting failure, which is a cheap way to burn server CPU. */
function assertInBounds(warehouse, point, label) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new ApiError(400, `${label} must be a point with numeric x and y`);
  }
  if (point.x < 0 || point.y < 0 || point.x >= warehouse.cols || point.y >= warehouse.rows) {
    throw new ApiError(422, `${label} (${point.x}, ${point.y}) is outside the warehouse bounds`);
  }
}

const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  // Scoped to the caller. Without the ownerId term this endpoint returned
  // every warehouse on the deployment - both a listing of other tenants'
  // data and a ready-made source of ObjectIds to probe.
  const filter = { ownerId: req.userId };
  if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

  const [items, total] = await Promise.all([
    Warehouse.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    Warehouse.countDocuments(filter),
  ]);

  res.json({ success: true, data: items, meta: buildMeta({ page, limit, total }) });
});

// requireWarehouseParam has already loaded and ownership-checked the
// document into req.warehouse, so the handlers below never re-query by a
// raw client-supplied id.
const getOne = asyncHandler(async (req, res) => {
  res.json({ success: true, data: req.warehouse });
});

const create = asyncHandler(async (req, res) => {
  const warehouse = await Warehouse.create({
    ...pick(req.body, CREATE_FIELDS),
    ownerId: req.userId,
  });
  res.status(201).json({ success: true, data: warehouse });
});

const update = asyncHandler(async (req, res) => {
  const warehouse = await Warehouse.findOneAndUpdate(
    { _id: req.warehouse._id, ownerId: req.userId },
    { $set: pick(req.body, UPDATE_FIELDS) },
    { new: true, runValidators: true, context: 'query' }
  );
  if (!warehouse) throw new ApiError(404, 'Warehouse not found');
  simulationManager.invalidate(warehouse._id); // the grid a live engine was built from may now be stale
  tickRunner.forgetWarehouse(warehouse._id);
  res.json({ success: true, data: warehouse });
});

const remove = asyncHandler(async (req, res) => {
  const warehouse = await Warehouse.findOneAndDelete({ _id: req.warehouse._id, ownerId: req.userId });
  if (!warehouse) throw new ApiError(404, 'Warehouse not found');
  simulationManager.invalidate(warehouse._id);
  tickRunner.forgetWarehouse(warehouse._id); // Milestone 14: don't leak a cache entry for a deleted warehouse
  res.status(204).send();
});

const activate = asyncHandler(async (req, res) => {
  // Scoped by owner inside the model helper: activating one warehouse
  // deactivates the caller's others, never another user's.
  const warehouse = await Warehouse.activate(req.warehouse._id, req.userId);
  if (!warehouse) throw new ApiError(404, 'Warehouse not found');
  res.json({ success: true, data: warehouse });
});

// Exposed now as a way to inspect/test the A* engine (Milestone 4) against
// real saved layouts; the Robot Engine (Milestone 5) calls `findPath`
// directly for its own movement decisions rather than going through HTTP.
// `trace: true` (Milestone 12) switches to `findPathWithTrace`, which
// additionally records the full step-by-step search (open/closed sets,
// current node, parent links) for the AI Visualisation Panel to scrub
// through - see astar.js's own docs on why that's opt-in rather than the
// default, and middleware/rateLimit.js for why it gets a tighter budget.
const findRoute = asyncHandler(async (req, res) => {
  const warehouse = req.warehouse;
  const { start, goal, heuristic, allowDiagonal, trace } = req.body;

  assertInBounds(warehouse, start, 'start');
  assertInBounds(warehouse, goal, 'goal');

  const grid = warehouseToGrid(warehouse);
  const options = { heuristic: heuristic || 'manhattan', allowDiagonal: Boolean(allowDiagonal) };
  const result = trace ? findPathWithTrace(grid, start, goal, options) : findPath(grid, start, goal, options);

  res.json({ success: true, data: result });
});

// Manually advances this warehouse's live simulation by `deltaSeconds`:
// moves every robot, advances any order a robot just arrived for
// (pickup -> delivery, or delivery -> complete), logs any robot that
// entered an error state, and dispatches newly-idle robots onto any
// pending orders - a full simulation step. Milestone 11 added a
// server-owned interval loop (src/sockets/tickLoopManager.js) that calls
// the same tickRunner.runTick this endpoint does, so both a manual request
// here and the automatic real-time loop broadcast identically over
// Socket.IO - this endpoint remains useful for scripting/testing a single
// step without needing a socket connection.
const tick = asyncHandler(async (req, res) => {
  const deltaSeconds = req.body.deltaSeconds ?? 1;
  const result = await tickRunner.runTick(req.warehouse._id, deltaSeconds);
  if (!result) throw new ApiError(404, 'Warehouse not found');

  const { changed, orderEvents, dispatched } = result;
  res.json({
    success: true,
    data: { changed, count: changed.length, orderEvents, dispatched },
  });
});

const generateOrders = asyncHandler(async (req, res) => {
  const count = req.body.count ?? 5;
  const orders = await orderService.generateOrders(req.warehouse._id, count);
  res.status(201).json({ success: true, data: orders });
});

const dispatchOrders = asyncHandler(async (req, res) => {
  const assignments = await orderService.dispatchPendingOrders(req.warehouse._id);
  res.json({ success: true, data: { assignments, count: assignments.length } });
});

// Dynamic obstacles (Milestone 9) live only in the live engine's memory,
// same as the robot task queue - see the note on Robot.taskQueue. They're
// runtime simulation state, not part of the warehouse's saved layout.
const listObstacles = asyncHandler(async (req, res) => {
  const engine = await simulationManager.getEngine(req.warehouse._id);
  if (!engine) throw new ApiError(404, 'Warehouse not found');
  res.json({ success: true, data: engine.getObstacles() });
});

function broadcastObstacles(warehouseId, engine) {
  simulationEvents.emit('obstacles:changed', {
    warehouseId: String(warehouseId),
    obstacles: typeof engine.getObstacles === 'function' ? engine.getObstacles() : [],
  });
}

const addObstacle = asyncHandler(async (req, res) => {
  const warehouse = req.warehouse;
  const payload = pick(req.body, OBSTACLE_FIELDS);

  for (const cell of payload.cells || []) {
    assertInBounds(warehouse, cell, 'obstacle cell');
  }

  const engine = await simulationManager.getEngine(warehouse._id);
  if (!engine) throw new ApiError(404, 'Warehouse not found');
  const obstacle = engine.addObstacle(payload);
  broadcastObstacles(warehouse._id, engine);
  res.status(201).json({ success: true, data: obstacle });
});

const removeObstacle = asyncHandler(async (req, res) => {
  const engine = await simulationManager.getEngine(req.warehouse._id);
  if (!engine) throw new ApiError(404, 'Warehouse not found');
  const removed = engine.removeObstacle(req.params.obstacleId);
  if (!removed) throw new ApiError(404, 'Obstacle not found');
  broadcastObstacles(req.warehouse._id, engine);
  res.status(204).send();
});

module.exports = {
  list,
  getOne,
  create,
  update,
  remove,
  activate,
  findRoute,
  tick,
  generateOrders,
  dispatchOrders,
  listObstacles,
  addObstacle,
  removeObstacle,
};

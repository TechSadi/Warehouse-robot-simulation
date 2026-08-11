const Warehouse = require('../models/Warehouse');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');
const { findPath, findPathWithTrace } = require('../engine/pathfinding/astar');
const { warehouseToGrid } = require('../engine/grid/warehouseGrid');
const simulationManager = require('../services/simulationManager');
const orderService = require('../services/orderService');
const tickRunner = require('../services/tickRunner');
const simulationEvents = require('../events/simulationEvents');
const list = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

  const [items, total] = await Promise.all([
    Warehouse.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    Warehouse.countDocuments(filter),
  ]);

  res.json({ success: true, data: items, meta: buildMeta({ page, limit, total }) });
});

const getOne = asyncHandler(async (req, res) => {
  const warehouse = await Warehouse.findById(req.params.id);
  if (!warehouse) throw new ApiError(404, 'Warehouse not found');
  res.json({ success: true, data: warehouse });
});

const create = asyncHandler(async (req, res) => {
  const warehouse = await Warehouse.create(req.body);
  res.status(201).json({ success: true, data: warehouse });
});

const update = asyncHandler(async (req, res) => {
  const warehouse = await Warehouse.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
    context: 'query',
  });
  if (!warehouse) throw new ApiError(404, 'Warehouse not found');
  simulationManager.invalidate(req.params.id); // the grid a live engine was built from may now be stale
  tickRunner.forgetWarehouse(req.params.id);
  res.json({ success: true, data: warehouse });
});

const remove = asyncHandler(async (req, res) => {
  const warehouse = await Warehouse.findByIdAndDelete(req.params.id);
  if (!warehouse) throw new ApiError(404, 'Warehouse not found');
  simulationManager.invalidate(req.params.id);
  tickRunner.forgetWarehouse(req.params.id); // Milestone 14: don't leak a cache entry for a deleted warehouse
  res.status(204).send();
});

const activate = asyncHandler(async (req, res) => {
  const warehouse = await Warehouse.activate(req.params.id);
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
// default.
const findRoute = asyncHandler(async (req, res) => {
  const warehouse = await Warehouse.findById(req.params.id);
  if (!warehouse) throw new ApiError(404, 'Warehouse not found');

  const { start, goal, heuristic, allowDiagonal, trace } = req.body;
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
  const result = await tickRunner.runTick(req.params.id, deltaSeconds);
  if (!result) throw new ApiError(404, 'Warehouse not found');

  const { changed, orderEvents, dispatched } = result;
  res.json({
    success: true,
    data: { changed, count: changed.length, orderEvents, dispatched },
  });
});

const generateOrders = asyncHandler(async (req, res) => {
  const count = req.body.count ?? 5;
  const orders = await orderService.generateOrders(req.params.id, count);
  res.status(201).json({ success: true, data: orders });
});

const dispatchOrders = asyncHandler(async (req, res) => {
  const assignments = await orderService.dispatchPendingOrders(req.params.id);
  res.json({ success: true, data: { assignments, count: assignments.length } });
});

// Dynamic obstacles (Milestone 9) live only in the live engine's memory,
// same as the robot task queue - see the note on Robot.taskQueue. They're
// runtime simulation state, not part of the warehouse's saved layout.
const listObstacles = asyncHandler(async (req, res) => {
  const engine = await simulationManager.getEngine(req.params.id);
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
  const engine = await simulationManager.getEngine(req.params.id);
  if (!engine) throw new ApiError(404, 'Warehouse not found');
  const obstacle = engine.addObstacle(req.body);
  broadcastObstacles(req.params.id, engine);
  res.status(201).json({ success: true, data: obstacle });
});

const removeObstacle = asyncHandler(async (req, res) => {
  const engine = await simulationManager.getEngine(req.params.id);
  if (!engine) throw new ApiError(404, 'Warehouse not found');
  const removed = engine.removeObstacle(req.params.obstacleId);
  if (!removed) throw new ApiError(404, 'Obstacle not found');
  broadcastObstacles(req.params.id, engine);
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

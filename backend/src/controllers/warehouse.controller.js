const Warehouse = require('../models/Warehouse');
const Robot = require('../models/Robot');
const Order = require('../models/Order');
const Log = require('../models/Log');
const Statistics = require('../models/Statistics');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');
const { pick } = require('../middleware/dto');
const { findPath, findPathWithTrace } = require('../engine/pathfinding/astar');
const { warehouseToGrid } = require('../engine/grid/warehouseGrid');
const simulationManager = require('../services/simulationManager');
const orderService = require('../services/orderService');
const tickRunner = require('../services/tickRunner');
const warehouseLock = require('../services/warehouseLock');
const simulationEvents = require('../events/simulationEvents');
const { accessibleFilter, accessLevelFor } = require('../middleware/authorize');
const User = require('../models/User');
const audit = require('../services/securityAudit');

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
/** A warehouse as a plain object, so the caller's access level can be
 * appended to it. Tolerant of a document that is already plain - a `lean()`
 * query and a test fixture both are, and neither should have to grow a
 * `toObject` just to be serialisable. */
function plain(warehouse) {
  return typeof warehouse?.toObject === 'function' ? warehouse.toObject() : { ...warehouse };
}

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
  // Scoped to the caller. Without this term the endpoint returned every
  // warehouse on the deployment - both a listing of other tenants' data
  // and a ready-made source of ObjectIds to probe. `accessibleFilter`
  // covers warehouses shared *with* the caller as well as their own, and
  // is the same filter the single-warehouse guards use, so a warehouse can
  // never be listable but not readable (or the reverse).
  const filter = { ...accessibleFilter(req.userId) };
  if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === 'true';

  const [items, total] = await Promise.all([
    Warehouse.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    Warehouse.countDocuments(filter),
  ]);

  res.json({
    success: true,
    // Each entry carries how far this caller reaches into it, so the
    // client can render a shared warehouse read-only without having to
    // discover that by getting a 403.
    data: items.map((w) => ({ ...plain(w), access: accessLevelFor(w, req.userId) })),
    meta: buildMeta({ page, limit, total }),
  });
});

// requireWarehouseParam has already loaded and ownership-checked the
// document into req.warehouse, so the handlers below never re-query by a
// raw client-supplied id.
const getOne = asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: { ...plain(req.warehouse), access: req.warehouseAccess },
  });
});

const create = asyncHandler(async (req, res) => {
  const warehouse = await Warehouse.create({
    ...pick(req.body, CREATE_FIELDS),
    ownerId: req.userId,
  });
  res.status(201).json({ success: true, data: warehouse });
});

/** Fields whose change makes a live engine's grid stale. Renaming a
 * warehouse or switching its scheduling strategy does not: the first is
 * cosmetic, and the second is read fresh from Mongo on every dispatch. */
const LAYOUT_FIELDS = ['rows', 'cols', 'cells'];

const update = asyncHandler(async (req, res) => {
  const patch = pick(req.body, UPDATE_FIELDS);
  const layoutChanged = LAYOUT_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(patch, f));

  // Inside the lock so the reload boundary is a clean one: no tick,
  // dispatch or obstacle change is left half-applied to the engine that is
  // about to be discarded.
  const warehouse = await warehouseLock.runExclusive(req.warehouse._id, async () => {
    const updated = await Warehouse.findOneAndUpdate(
      { _id: req.warehouse._id, ownerId: req.userId },
      { $set: patch },
      { new: true, runValidators: true, context: 'query' }
    );
    if (!updated) throw new ApiError(404, 'Warehouse not found');

    // Dropping the engine also drops every piece of runtime-only state
    // built on it - dynamic obstacles, robot task queues, and the order
    // coordinator's assignments - so the next load reconciles the orders
    // those assignments were driving back to `pending` rather than
    // stranding them (see simulationManager.reconcileWarehouse). Which is
    // exactly why this now only fires when the *layout* changed: renaming
    // a warehouse used to silently reset a running simulation.
    if (layoutChanged) {
      simulationManager.invalidate(updated._id);
      tickRunner.forgetWarehouse(updated._id);
    }
    return updated;
  });

  if (layoutChanged) {
    simulationEvents.emit('notification', {
      warehouseId: String(warehouse._id),
      level: 'info',
      message: 'Warehouse layout changed - the running simulation was reloaded and in-flight orders requeued.',
      timestamp: new Date().toISOString(),
    });
  }

  res.json({ success: true, data: warehouse });
});

/**
 * Deleting a warehouse cascades to everything that hangs off it.
 *
 * Previously only the Warehouse document was deleted, which left its
 * robots, orders, statistics snapshots and logs in their collections
 * forever. Those documents were not merely untidy - they were
 * *unreachable*: this application derives every authorization decision
 * from the warehouse a document belongs to (middleware/authorize.js), so
 * once the warehouse is gone nothing can list, read or delete them through
 * the API, by anyone, ever. They only accumulated.
 *
 * Hard cascade rather than a soft delete, deliberately. A soft delete
 * earns its complexity when something still needs to read the deleted
 * thing - undo, audit, or billing. Nothing here does: this is a
 * simulation, its logs and statistics describe a layout that no longer
 * exists, and every read path in the app would have to grow an
 * `isDeleted` term that is one forgotten filter away from leaking deleted
 * data back into a listing. The cost of getting hard delete wrong is
 * bounded and obvious; the cost of getting soft delete wrong is silent.
 *
 * Children are deleted *before* the parent, and without a transaction.
 * MongoDB transactions require a replica set, which this deployment does
 * not, so ordering carries the guarantee instead: if the process dies
 * part-way through, the warehouse still exists, its remaining children are
 * still reachable and still owned, and repeating the request finishes the
 * job. The reverse order would produce exactly the orphans this is fixing.
 */
const remove = asyncHandler(async (req, res) => {
  const warehouseId = req.warehouse._id;

  // Stop the simulation and drop the engine first, so nothing is ticking
  // (or writing robots back) while the collections are being emptied.
  simulationEvents.emit('warehouse:deleted', { warehouseId: String(warehouseId) });
  await warehouseLock.runExclusive(warehouseId, () => {
    simulationManager.invalidate(warehouseId);
    tickRunner.forgetWarehouse(warehouseId);
  });

  const [robots, orders, statistics, logs] = await Promise.all([
    Robot.deleteMany({ warehouseId }),
    Order.deleteMany({ warehouseId }),
    Statistics.deleteMany({ warehouseId }),
    Log.deleteMany({ warehouseId }),
  ]);

  const warehouse = await Warehouse.findOneAndDelete({ _id: warehouseId, ownerId: req.userId });
  if (!warehouse) throw new ApiError(404, 'Warehouse not found');

  console.log(
    `[warehouse] deleted ${warehouseId} and its dependents: ` +
      `${robots?.deletedCount ?? 0} robot(s), ${orders?.deletedCount ?? 0} order(s), ` +
      `${statistics?.deletedCount ?? 0} statistics snapshot(s), ${logs?.deletedCount ?? 0} log(s)`
  );

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
  // runTick takes the warehouse lock, so a manual tick arriving while the
  // automatic loop is mid-tick waits its turn and is then applied as a
  // whole, separate step - never interleaved with one. If the warehouse is
  // so backed up that the queue is full, runTick rejects with a 503 rather
  // than adding to it (services/warehouseLock.js).
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

/**
 * Dynamic obstacles (Milestone 9) are runtime simulation state rather than
 * part of the warehouse's saved *layout* - but they are persisted now (see
 * models/Warehouse.js), so they survive a restart, a layout edit and an
 * engine-cache eviction instead of silently vanishing from under the
 * robots routing around them.
 *
 * Read through `readObstacles`, which returns the live set when an engine
 * happens to be loaded and the stored set otherwise. Deliberately *not*
 * `getEngine`: building an engine reconciles the persisted fleet against
 * what it could actually load, and that writes - so listing a warehouse's
 * obstacles used to be a `GET` that quietly performed a recovery pass.
 */
const listObstacles = asyncHandler(async (req, res) => {
  const obstacles = await simulationManager.readObstacles(req.warehouse._id);
  if (!obstacles) throw new ApiError(404, 'Warehouse not found');
  res.json({ success: true, data: obstacles });
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

  // Serialized with ticks: adding an obstacle mid-tick would block cells
  // for robots the tick has not reached yet while the ones it already
  // moved planned against the old obstacle set, so a single engine step
  // would have seen two different worlds.
  const { obstacle, engine } = await warehouseLock.runExclusive(warehouse._id, async () => {
    const live = await simulationManager.getEngine(warehouse._id);
    if (!live) throw new ApiError(404, 'Warehouse not found');
    const created = live.addObstacle(payload);
    // Inside the lock, so the stored set can never be written from a
    // half-applied engine state - and before the response, so a client
    // that reads back immediately sees what it just created.
    await simulationManager.persistObstacles(warehouse._id, live);
    return { obstacle: created, engine: live };
  });
  broadcastObstacles(warehouse._id, engine);
  res.status(201).json({ success: true, data: obstacle });
});

const removeObstacle = asyncHandler(async (req, res) => {
  const engine = await warehouseLock.runExclusive(req.warehouse._id, async () => {
    const live = await simulationManager.getEngine(req.warehouse._id);
    if (!live) throw new ApiError(404, 'Warehouse not found');
    if (!live.removeObstacle(req.params.obstacleId)) throw new ApiError(404, 'Obstacle not found');
    await simulationManager.persistObstacles(req.warehouse._id, live);
    return live;
  });
  broadcastObstacles(req.warehouse._id, engine);
  res.status(204).send();
});

/**
 * Sharing.
 *
 * All three of these require `own` access (enforced at the route), which
 * is the point: an editor can change everything *in* a warehouse and
 * nothing about *who can reach it*. Otherwise the first person you shared
 * with could share it onward, or remove you.
 *
 * Collaborators are addressed by email rather than by user id. A user id
 * is not something one person knows about another, and an endpoint that
 * turned an id into "yes, that account exists" would be an enumeration
 * oracle over the whole user table. An email address is something the
 * owner already has - and inviting an address that has no account answers
 * exactly as if it does, for the same reason.
 */
const listCollaborators = asyncHandler(async (req, res) => {
  const collaborators = req.warehouse.collaborators || [];
  const users = await User.find({ _id: { $in: collaborators.map((c) => c.userId) } }).select(
    'email name'
  );
  const byId = new Map(users.map((u) => [String(u._id), u]));

  res.json({
    success: true,
    data: collaborators.map((c) => ({
      userId: String(c.userId),
      // A deleted account leaves a membership behind; report it rather
      // than dropping the row, so the owner can see and remove it.
      email: byId.get(String(c.userId))?.email ?? null,
      name: byId.get(String(c.userId))?.name ?? null,
      role: c.role,
      addedAt: c.addedAt,
    })),
  });
});

const addCollaborator = asyncHandler(async (req, res) => {
  const email = String(req.body.email).toLowerCase();
  const role = req.body.role || 'viewer';

  const invitee = await User.findOne({ email }).select('_id email name');
  // Deliberately the same 200-shaped refusal whether the address has no
  // account or already has access: this endpoint must not become a way to
  // ask "does this person have an account here?".
  if (!invitee || String(invitee._id) === String(req.warehouse.ownerId)) {
    throw new ApiError(422, 'That address cannot be added to this warehouse');
  }

  // Upsert rather than reject-if-present: re-inviting someone at a
  // different role is how a role is changed, and a separate PATCH for it
  // would be a second write path into the same field.
  const existing = (req.warehouse.collaborators || []).find(
    (c) => String(c.userId) === String(invitee._id)
  );
  const updated = existing
    ? await Warehouse.findOneAndUpdate(
        { _id: req.warehouse._id, 'collaborators.userId': invitee._id },
        { $set: { 'collaborators.$.role': role } },
        { new: true }
      )
    : await Warehouse.findOneAndUpdate(
        { _id: req.warehouse._id },
        {
          $push: {
            collaborators: { userId: invitee._id, role, addedBy: req.userId, addedAt: new Date() },
          },
        },
        { new: true }
      );

  audit.record('admin_action', {
    req,
    userId: req.userId,
    email,
    detail: { action: 'share_warehouse', warehouseId: String(req.warehouse._id), role },
    outcome: 'success',
  });

  res.status(201).json({
    success: true,
    data: {
      userId: String(invitee._id),
      email: invitee.email,
      name: invitee.name,
      role,
      collaborators: updated.collaborators.length,
    },
  });
});

const removeCollaborator = asyncHandler(async (req, res) => {
  const updated = await Warehouse.findOneAndUpdate(
    { _id: req.warehouse._id },
    { $pull: { collaborators: { userId: req.params.userId } } },
    { new: true }
  );
  if (!updated) throw new ApiError(404, 'Warehouse not found');

  audit.record('admin_action', {
    req,
    userId: req.userId,
    detail: {
      action: 'unshare_warehouse',
      warehouseId: String(req.warehouse._id),
      target: String(req.params.userId),
    },
    outcome: 'success',
  });
  res.status(204).send();
});

module.exports = {
  listCollaborators,
  addCollaborator,
  removeCollaborator,
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

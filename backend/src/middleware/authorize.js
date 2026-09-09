const Warehouse = require('../models/Warehouse');
const asyncHandler = require('../utils/asyncHandler');
const { ApiError } = require('./errorHandler');

/**
 * Resource-level authorization.
 *
 * Authentication only establishes *who* is calling. Every resource in this
 * app hangs off exactly one warehouse:
 *
 *   User -> Warehouse -> { Robots, Orders, Obstacles, Statistics, Logs }
 *
 * so "may this caller touch this object?" always reduces to "does the
 * caller own the warehouse this object belongs to?". These helpers are the
 * single place that question is answered, for REST and Socket.IO alike -
 * no controller performs its own ownership check, because a check that
 * lives in twelve controllers is a check that will be forgotten in the
 * thirteenth.
 *
 * A warehouse the caller does not own answers **404, not 403**. A 403
 * confirms the id exists, which is all an attacker enumerating ObjectIds
 * needs; an indistinguishable 404 tells them nothing.
 */

/** Resolves ownership of a single warehouse id. Returns null when the
 * warehouse does not exist *or* belongs to someone else - the caller
 * cannot tell the two apart, by design. */
async function findOwnedWarehouse(warehouseId, userId) {
  if (!warehouseId) return null;
  return Warehouse.findOne({ _id: warehouseId, ownerId: userId });
}

/** Every warehouse id this user owns - used to scope collection endpoints
 * that were not given an explicit warehouseId filter. */
async function ownedWarehouseIds(userId) {
  const owned = await Warehouse.find({ ownerId: userId }).select('_id');
  return owned.map((w) => w._id);
}

/**
 * Guards a route whose warehouse is identified by a path parameter
 * (default `:id`, or `:warehouseId` for nested routers). Attaches the
 * loaded document as `req.warehouse` so the controller does not re-query it.
 */
function requireWarehouseParam(paramName = 'id') {
  return asyncHandler(async (req, res, next) => {
    const warehouse = await findOwnedWarehouse(req.params[paramName], req.userId);
    if (!warehouse) throw new ApiError(404, 'Warehouse not found');
    req.warehouse = warehouse;
    next();
  });
}

/**
 * Guards a create/update route that names its warehouse in the body. The
 * client may only ever attach a new robot/order/statistic/log to a
 * warehouse it owns - otherwise anyone could inject documents into another
 * user's simulation without ever reading it.
 */
function requireWarehouseBody(field = 'warehouseId', { optional = false } = {}) {
  return asyncHandler(async (req, res, next) => {
    const warehouseId = req.body?.[field];
    if (warehouseId === undefined || warehouseId === null) {
      if (optional) return next();
      throw new ApiError(400, `${field} is required`);
    }

    const warehouse = await findOwnedWarehouse(warehouseId, req.userId);
    if (!warehouse) throw new ApiError(404, 'Warehouse not found');
    req.warehouse = warehouse;
    next();
  });
}

/**
 * Guards a route addressing a child document by its own id (a robot,
 * order, statistics snapshot or log). Loads the document, then verifies
 * the caller owns its warehouse. Both failure modes return the same 404,
 * so `GET /api/robots/<someone else's id>` is indistinguishable from
 * `GET /api/robots/<id that never existed>`.
 */
function requireOwnedResource(Model, label, { paramName = 'id', warehouseField = 'warehouseId' } = {}) {
  return asyncHandler(async (req, res, next) => {
    const doc = await Model.findById(req.params[paramName]);
    if (!doc) throw new ApiError(404, `${label} not found`);

    const warehouseId = doc[warehouseField];
    // A log entry may legitimately have no warehouse (system-level).
    // Those are server-authored and never readable by an end user.
    if (!warehouseId) throw new ApiError(404, `${label} not found`);

    const warehouse = await findOwnedWarehouse(warehouseId, req.userId);
    if (!warehouse) throw new ApiError(404, `${label} not found`);

    req.resource = doc;
    req.warehouse = warehouse;
    next();
  });
}

/**
 * Scopes a collection query to what the caller may see.
 *
 * If the request filters by an explicit `warehouseId`, that one warehouse
 * is ownership-checked. If it does not, the filter is narrowed to every
 * warehouse the caller owns - so an unfiltered `GET /api/robots` returns
 * the caller's robots rather than the entire fleet of every user on the
 * deployment, which is the quieter, easier-to-miss half of a BOLA bug.
 */
function scopeListToOwner({ queryField = 'warehouseId', filterField = 'warehouseId' } = {}) {
  return asyncHandler(async (req, res, next) => {
    const requested = req.query?.[queryField];

    if (requested) {
      const warehouse = await findOwnedWarehouse(requested, req.userId);
      if (!warehouse) throw new ApiError(404, 'Warehouse not found');
      req.ownershipFilter = { [filterField]: warehouse._id };
      req.warehouse = warehouse;
      return next();
    }

    const ids = await ownedWarehouseIds(req.userId);
    req.ownershipFilter = { [filterField]: { $in: ids } };
    next();
  });
}

module.exports = {
  findOwnedWarehouse,
  ownedWarehouseIds,
  requireWarehouseParam,
  requireWarehouseBody,
  requireOwnedResource,
  scopeListToOwner,
};

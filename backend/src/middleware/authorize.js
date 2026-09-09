const Warehouse = require('../models/Warehouse');
const asyncHandler = require('../utils/asyncHandler');
const { ApiError } = require('./errorHandler');
const audit = require('../services/securityAudit');

/**
 * Resource-level authorization.
 *
 * Authentication only establishes *who* is calling. Every resource in this
 * app hangs off exactly one warehouse:
 *
 *   User -> Warehouse -> { Robots, Orders, Obstacles, Statistics, Logs }
 *
 * so "may this caller touch this object?" always reduces to "how far does
 * this caller reach into the warehouse this object belongs to?". These
 * helpers are the single place that question is answered, for REST and
 * Socket.IO alike - no controller performs its own ownership check,
 * because a check that lives in twelve controllers is a check that will be
 * forgotten in the thirteenth.
 *
 * **Three levels, not two.** Warehouses can now be shared (see
 * `collaborators` in models/Warehouse.js), so the answer is no longer
 * yes/no:
 *
 *   view   - read, and watch the live simulation
 *   edit   - everything above, plus changing the contents: robots, orders,
 *            obstacles, ticking, starting and stopping
 *   own    - everything above, plus the three things that are about the
 *            warehouse's existence rather than its contents: deleting it,
 *            changing its layout, and changing who else can reach it
 *
 * Each level includes the ones below it. Guards name the level they need,
 * so the requirement is stated at the route rather than inferred from the
 * HTTP verb - `POST /:id/tick` is a write in every sense that matters, and
 * `PUT /:id` is not the same thing as `POST /:id/orders/generate`.
 *
 * A warehouse the caller cannot reach *at all* answers **404, not 403**. A
 * 403 confirms the id exists, which is all an attacker enumerating
 * ObjectIds needs; an indistinguishable 404 tells them nothing. A caller
 * who *can* reach it but not far enough gets **403**, because at that
 * point there is nothing left to conceal - they already know it exists -
 * and "you may look but not touch" is genuinely useful to be told.
 */

const ACCESS = { VIEW: 'view', EDIT: 'edit', OWN: 'own' };
const ACCESS_RANK = { view: 1, edit: 2, own: 3 };
const ROLE_ACCESS = { viewer: 'view', editor: 'edit' };

/** How far this user reaches into this warehouse, or null. */
function accessLevelFor(warehouse, userId) {
  if (!warehouse) return null;
  if (String(warehouse.ownerId) === String(userId)) return ACCESS.OWN;
  const membership = (warehouse.collaborators || []).find(
    (c) => String(c.userId) === String(userId)
  );
  return membership ? ROLE_ACCESS[membership.role] || null : null;
}

function satisfies(level, required) {
  return Boolean(level) && ACCESS_RANK[level] >= ACCESS_RANK[required];
}

/** The Mongo filter for "every warehouse this user can reach". Used both
 * to load one and to scope a listing, so the two can never disagree about
 * what reachable means. */
function accessibleFilter(userId) {
  return { $or: [{ ownerId: userId }, { 'collaborators.userId': userId }] };
}

/**
 * Loads a warehouse the caller can reach at least `required` far.
 *
 * Returns `{ warehouse, level }` on success. Throws 404 when the caller
 * cannot reach it at all (indistinguishable from one that never existed),
 * and 403 when they can reach it but not far enough.
 */
async function loadAccessibleWarehouse(warehouseId, userId, required = ACCESS.OWN) {
  if (!warehouseId) throw new ApiError(404, 'Warehouse not found');
  const warehouse = await Warehouse.findOne({ _id: warehouseId, ...accessibleFilter(userId) });
  const level = accessLevelFor(warehouse, userId);
  if (!warehouse || !level) throw new ApiError(404, 'Warehouse not found');
  if (!satisfies(level, required)) {
    throw new ApiError(403, `This action requires ${required} access to the warehouse`, {
      required,
      granted: level,
    });
  }
  return { warehouse, level };
}

/**
 * Resolves ownership of a single warehouse id. Returns null when the
 * warehouse does not exist *or* the caller cannot reach it - the caller
 * cannot tell the two apart, by design.
 *
 * Kept as the ownership-only form because that is what the Socket.IO layer
 * and the telemetry endpoint want, and because widening it silently would
 * be exactly the wrong way to introduce sharing. Callers that mean "can
 * reach" ask for `findAccessibleWarehouse`.
 */
async function findOwnedWarehouse(warehouseId, userId) {
  if (!warehouseId) return null;
  return Warehouse.findOne({ _id: warehouseId, ownerId: userId });
}

/** The sharing-aware equivalent: the warehouse if the caller reaches it at
 * least `required` far, otherwise null. Never throws - for callers (the
 * socket layer) that answer in their own vocabulary. */
async function findAccessibleWarehouse(warehouseId, userId, required = ACCESS.VIEW) {
  if (!warehouseId) return null;
  const warehouse = await Warehouse.findOne({ _id: warehouseId, ...accessibleFilter(userId) });
  const level = accessLevelFor(warehouse, userId);
  if (!warehouse || !satisfies(level, required)) return null;
  return warehouse;
}

/** Every warehouse id this user can reach - used to scope collection
 * endpoints that were not given an explicit warehouseId filter. */
async function ownedWarehouseIds(userId) {
  const reachable = await Warehouse.find(accessibleFilter(userId)).select('_id');
  return reachable.map((w) => w._id);
}

/**
 * Guards a route whose warehouse is identified by a path parameter
 * (default `:id`, or `:warehouseId` for nested routers). Attaches the
 * loaded document as `req.warehouse` and the caller's level as
 * `req.warehouseAccess`, so the controller does not re-query either.
 */
function requireWarehouseParam(paramName = 'id', { access = ACCESS.EDIT } = {}) {
  return asyncHandler(async (req, res, next) => {
    const { warehouse, level } = await loadAccessibleWarehouse(
      req.params[paramName],
      req.userId,
      access
    ).catch((err) => {
      if (err.statusCode === 403) {
        audit.record('authorization_denied', {
          req,
          userId: req.userId,
          detail: { warehouseId: String(req.params[paramName]), required: access },
        });
      }
      throw err;
    });
    req.warehouse = warehouse;
    req.warehouseAccess = level;
    next();
  });
}

/**
 * Guards a create/update route that names its warehouse in the body. The
 * client may only ever attach a new robot/order/statistic/log to a
 * warehouse it can edit - otherwise anyone could inject documents into
 * another user's simulation without ever reading it.
 */
function requireWarehouseBody(field = 'warehouseId', { optional = false, access = ACCESS.EDIT } = {}) {
  return asyncHandler(async (req, res, next) => {
    const warehouseId = req.body?.[field];
    if (warehouseId === undefined || warehouseId === null) {
      if (optional) return next();
      throw new ApiError(400, `${field} is required`);
    }

    const { warehouse, level } = await loadAccessibleWarehouse(warehouseId, req.userId, access);
    req.warehouse = warehouse;
    req.warehouseAccess = level;
    next();
  });
}

/**
 * Guards a route addressing a child document by its own id (a robot,
 * order, statistics snapshot or log). Loads the document, then resolves
 * the caller's access to its warehouse. A warehouse the caller cannot
 * reach at all returns the same 404 as a document that never existed, so
 * `GET /api/robots/<someone else's id>` is indistinguishable from
 * `GET /api/robots/<id that never existed>`.
 */
function requireOwnedResource(
  Model,
  label,
  { paramName = 'id', warehouseField = 'warehouseId', access = ACCESS.EDIT } = {}
) {
  return asyncHandler(async (req, res, next) => {
    const doc = await Model.findById(req.params[paramName]);
    if (!doc) throw new ApiError(404, `${label} not found`);

    const warehouseId = doc[warehouseField];
    // A log entry may legitimately have no warehouse (system-level).
    // Those are server-authored and never readable by an end user.
    if (!warehouseId) throw new ApiError(404, `${label} not found`);

    let resolved;
    try {
      resolved = await loadAccessibleWarehouse(warehouseId, req.userId, access);
    } catch (err) {
      // The 404 is relabelled to the child, so the response never reveals
      // that the *warehouse* is the thing that was not found.
      if (err.statusCode === 404) throw new ApiError(404, `${label} not found`);
      throw err;
    }

    req.resource = doc;
    req.warehouse = resolved.warehouse;
    req.warehouseAccess = resolved.level;
    next();
  });
}

/**
 * Scopes a collection query to what the caller may see.
 *
 * If the request filters by an explicit `warehouseId`, that one warehouse
 * is access-checked. If it does not, the filter is narrowed to every
 * warehouse the caller can reach - so an unfiltered `GET /api/robots`
 * returns the caller's robots rather than the entire fleet of every user
 * on the deployment, which is the quieter, easier-to-miss half of a BOLA
 * bug.
 */
function scopeListToOwner({
  queryField = 'warehouseId',
  filterField = 'warehouseId',
  access = ACCESS.VIEW,
} = {}) {
  return asyncHandler(async (req, res, next) => {
    const requested = req.query?.[queryField];

    if (requested) {
      const { warehouse, level } = await loadAccessibleWarehouse(requested, req.userId, access);
      req.ownershipFilter = { [filterField]: warehouse._id };
      req.warehouse = warehouse;
      req.warehouseAccess = level;
      return next();
    }

    const ids = await ownedWarehouseIds(req.userId);
    req.ownershipFilter = { [filterField]: { $in: ids } };
    next();
  });
}

module.exports = {
  ACCESS,
  accessLevelFor,
  accessibleFilter,
  satisfies,
  loadAccessibleWarehouse,
  findOwnedWarehouse,
  findAccessibleWarehouse,
  ownedWarehouseIds,
  requireWarehouseParam,
  requireWarehouseBody,
  requireOwnedResource,
  scopeListToOwner,
};

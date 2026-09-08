/**
 * Allow-list projection for request bodies.
 *
 * Every write path in this app builds its update from `pick(req.body, ...)`
 * rather than from `req.body` itself. Handing a user-controlled object
 * straight to `Model.create` / `findByIdAndUpdate` is mass assignment: the
 * client decides which columns to write, so any field the schema happens
 * to have - `ownerId`, `_id`, `tokenVersion`, `role`, `createdAt`, an
 * order's `deliveredAt`, a robot's internal simulation state - becomes
 * client-controlled. Validation alone does not help, because a validator
 * only constrains the fields it was told about and silently ignores the
 * rest.
 *
 * A deny-list would be the wrong shape here: it fails open every time
 * someone adds a field to a schema. This fails closed.
 */
function pick(source, allowed) {
  const out = {};
  if (!source || typeof source !== 'object') return out;

  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Rejects Mongo operator injection in values that reach a query or an
 * update. Express's JSON body parser happily produces
 * `{ email: { $gt: '' } }` from valid JSON, which as a query filter
 * matches the first user in the collection - an authentication bypass
 * that never involves a password.
 */
function hasMongoOperators(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return false;

  if (Array.isArray(value)) return value.some((v) => hasMongoOperators(v, depth + 1));

  for (const [key, nested] of Object.entries(value)) {
    if (key.startsWith('$') || key.includes('.')) return true;
    if (hasMongoOperators(nested, depth + 1)) return true;
  }
  return false;
}

/** Strips `$`-prefixed and dotted keys from anything user-controlled.
 * Applied globally in app.js to body, query and params. */
function sanitize(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));

  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete value[key];
      continue;
    }
    sanitize(value[key], depth + 1);
  }
  return value;
}

/**
 * Express 5 makes `req.query` a getter, so it cannot be reassigned;
 * mutating in place works on both 4 and 5.
 */
function mongoSanitize(req, res, next) {
  sanitize(req.body);
  sanitize(req.query);
  sanitize(req.params);
  next();
}

module.exports = { pick, hasMongoOperators, sanitize, mongoSanitize };

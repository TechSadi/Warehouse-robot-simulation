/**
 * Test helpers for the authenticated API.
 *
 * Every REST route except /health and /auth now requires a signed-in
 * caller *and* ownership of the warehouse the resource belongs to. These
 * helpers issue a real token with the real signing code (utils/tokens.js)
 * rather than stubbing the middleware out - a test that mocks away the
 * auth layer proves nothing about the auth layer, and would keep passing
 * if requireAuth were deleted.
 */
const { signAccessToken } = require('../../src/utils/tokens');

const USER_A_ID = '507f1f77bcf86cd799439001';
const USER_B_ID = '507f1f77bcf86cd799439002';
const WAREHOUSE_A_ID = '507f1f77bcf86cd799439011';
const WAREHOUSE_B_ID = '507f1f77bcf86cd799439012';

/** A minimal stand-in for a User document, shaped as middleware/auth.js
 * and the auth controller actually use it. */
function makeUser(id = USER_A_ID, overrides = {}) {
  return {
    _id: id,
    id,
    email: `user-${id}@example.com`,
    name: 'Test User',
    role: 'user',
    tokenVersion: 0,
    toPublicJSON() {
      return { id, email: this.email, name: this.name, role: this.role };
    },
    ...overrides,
  };
}

function tokenFor(user) {
  return signAccessToken({
    _id: { toString: () => String(user._id) },
    role: user.role || 'user',
    tokenVersion: user.tokenVersion ?? 0,
  });
}

/**
 * Adds an Authorization header to a supertest request.
 *
 * The bearer path is used here rather than the cookie path purely for test
 * ergonomics; both go through the same `resolveUserFromToken`. The cookie
 * path (and the CSRF requirement that comes with it) has its own dedicated
 * coverage in tests/security/auth.test.js.
 */
function authed(req, user = makeUser()) {
  return req.set('Authorization', `Bearer ${tokenFor(user)}`);
}

/**
 * A warehouse document as the authorization middleware expects to find it.
 *
 * `toObject` is here because the controllers spread the document to append
 * the caller's access level to the response, and a Mongoose document is
 * not a plain object. Pass `collaborators` to exercise a shared warehouse.
 */
function makeWarehouse(id = WAREHOUSE_A_ID, ownerId = USER_A_ID, overrides = {}) {
  const doc = {
    _id: id,
    ownerId,
    name: 'Test Warehouse',
    rows: 20,
    cols: 20,
    cells: [],
    collaborators: [],
    dynamicObstacles: [],
    ...overrides,
  };
  doc.toObject = () => ({ ...doc, toObject: undefined });
  return doc;
}

/**
 * Wires the mocked Warehouse model so the authorization middleware
 * resolves for the given owner (and for anyone the warehouse is shared
 * with) and 404s for everyone else - the single query every access check
 * in middleware/authorize.js funnels through.
 *
 * The filter now takes two shapes, and this understands both:
 * `{ _id, ownerId }` for the ownership-only helper, and
 * `{ _id, $or: [{ownerId}, {'collaborators.userId'}] }` for the
 * sharing-aware one. Matching on the shape rather than on a fixed filter
 * is what lets one helper serve both without every caller knowing which
 * guard the route under test happens to use.
 */
function mockOwnership(Warehouse, { warehouse = makeWarehouse(), ownerId = USER_A_ID } = {}) {
  Warehouse.findOne.mockImplementation((filter = {}) => {
    const idMatches = !filter._id || String(filter._id) === String(warehouse._id);
    if (!idMatches) return Promise.resolve(null);

    // Which user is asking, whichever shape the filter came in.
    const asking = filter.ownerId ?? filter.$or?.[0]?.ownerId;
    if (asking === undefined) return Promise.resolve(warehouse);

    const isOwner = String(asking) === String(ownerId);
    const sharedWith =
      Boolean(filter.$or) &&
      (warehouse.collaborators || []).some((c) => String(c.userId) === String(asking));

    return Promise.resolve(isOwner || sharedWith ? warehouse : null);
  });
  return warehouse;
}

module.exports = {
  USER_A_ID,
  USER_B_ID,
  WAREHOUSE_A_ID,
  WAREHOUSE_B_ID,
  makeUser,
  makeWarehouse,
  tokenFor,
  authed,
  mockOwnership,
};

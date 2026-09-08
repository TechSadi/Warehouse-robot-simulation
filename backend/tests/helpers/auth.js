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

/** A warehouse document as the ownership middleware expects to find it. */
function makeWarehouse(id = WAREHOUSE_A_ID, ownerId = USER_A_ID, overrides = {}) {
  return { _id: id, ownerId, name: 'Test Warehouse', rows: 20, cols: 20, cells: [], ...overrides };
}

/**
 * Wires the mocked Warehouse model so `findOwnedWarehouse` resolves for
 * the given owner and 404s for anyone else - the single query every
 * ownership check in middleware/authorize.js funnels through.
 */
function mockOwnership(Warehouse, { warehouse = makeWarehouse(), ownerId = USER_A_ID } = {}) {
  Warehouse.findOne.mockImplementation((filter = {}) => {
    const idMatches = !filter._id || String(filter._id) === String(warehouse._id);
    const ownerMatches = !filter.ownerId || String(filter.ownerId) === String(ownerId);
    return Promise.resolve(idMatches && ownerMatches ? warehouse : null);
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

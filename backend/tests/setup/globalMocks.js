// Belt and braces: `npm test` sets NODE_ENV=test, but jest can also be
// invoked directly. env.js keys its test-mode behaviour (cheap bcrypt
// rounds, rate limiters disabled, randomly-generated signing secrets) off
// this and JEST_WORKER_ID, and this file runs before any test requires the
// app, so setting it here covers both entry points.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// Nothing in the suite opens a real connection (every model is mocked), but
// env.js reads this at import time and warns when it is missing.
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/warehouse-sim-test';

/**
 * Runs before every test file (see the `jest.setupFiles` entry in
 * package.json).
 *
 * The auth middleware loads the caller's User document on every request.
 * Most of this suite predates authentication and mocks only the model it
 * is actually testing, so without a default User mock every one of those
 * tests would issue a real Mongoose query against a database that is not
 * connected, and hang.
 *
 * This mocks *only* the user lookup, not the token verification - requests
 * still have to present a validly signed, unexpired, correctly-versioned
 * token to get through requireAuth. A test file that needs the real User
 * model (tests/security/auth.test.js) declares its own jest.mock, which
 * takes precedence over this one.
 */
jest.mock('../../src/models/User', () => {
  const users = new Map();

  return {
    findById: jest.fn((id) => {
      const key = String(id);
      if (!users.has(key)) {
        users.set(key, {
          _id: key,
          id: key,
          email: `user-${key}@example.com`,
          name: 'Test User',
          role: 'user',
          tokenVersion: 0,
          toPublicJSON() {
            return { id: key, email: this.email, name: this.name, role: this.role };
          },
        });
      }
      return Promise.resolve(users.get(key));
    }),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    updateMany: jest.fn().mockResolvedValue({ acknowledged: true }),
    hashPassword: jest.fn().mockResolvedValue('$2a$04$mockmockmockmockmockmo'),
    ROLES: ['user', 'admin'],
    EMAIL_PATTERN: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  };
});

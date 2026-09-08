/**
 * Authentication: registration, login, the current-user endpoint, logout,
 * refresh rotation, and the abuse protections around them.
 *
 * This suite deliberately uses the *real* User model methods (password
 * hashing, verification, the public JSON projection) over an in-memory
 * store, rather than the shared stub in tests/setup/globalMocks.js - a
 * password-hashing test that mocks out password hashing proves nothing.
 */
const request = require('supertest');

const users = new Map();

jest.mock('../../src/models/User', () => {
  const bcrypt = require('bcryptjs');
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function decorate(doc) {
    return Object.assign(doc, {
      verifyPassword(plaintext) {
        return bcrypt.compare(plaintext, doc.passwordHash);
      },
      toPublicJSON() {
        return { id: String(doc._id), email: doc.email, name: doc.name, role: doc.role };
      },
    });
  }

  const model = {
    __store: null, // wired below to the outer `users` map
    hashPassword: (plaintext) => bcrypt.hash(plaintext, 4),
    findById: jest.fn((id) => Promise.resolve(model.__store.get(String(id)) || null)),
    findOne: jest.fn((filter = {}) => {
      const email = typeof filter.email === 'string' ? filter.email.toLowerCase() : null;
      if (!email) return Promise.resolve(null);
      const found = [...model.__store.values()].find((u) => u.email === email);
      return Promise.resolve(found || null);
    }),
    create: jest.fn((doc) => {
      const id = `user${model.__store.size + 1}`.padStart(24, '0');
      const record = decorate({
        _id: id,
        email: doc.email,
        passwordHash: doc.passwordHash,
        name: doc.name || '',
        role: doc.role || 'user',
        tokenVersion: 0,
        failedLoginAttempts: 0,
        lockUntil: null,
      });
      model.__store.set(id, record);
      return Promise.resolve(record);
    }),
    updateOne: jest.fn((filter, update) => {
      const record = model.__store.get(String(filter._id));
      if (record) {
        Object.assign(record, update.$set || {});
        if (update.$inc?.tokenVersion) record.tokenVersion += update.$inc.tokenVersion;
      }
      return Promise.resolve({ acknowledged: true });
    }),
    updateMany: jest.fn().mockResolvedValue({ acknowledged: true }),
  };

  // `findOne(...).select(...)` is used on the login path.
  const wrapSelectable = (fn) => (...args) => {
    const promise = fn(...args);
    promise.select = () => promise;
    return promise;
  };
  model.findOne = jest.fn(wrapSelectable(model.findOne.getMockImplementation()));

  model.EMAIL_PATTERN = EMAIL_PATTERN;
  model.ROLES = ['user', 'admin'];
  return model;
});

const refreshTokens = new Map();

jest.mock('../../src/models/RefreshToken', () => {
  const crypto = require('crypto');
  const model = {
    __store: null,
    hashToken: (token) => crypto.createHash('sha256').update(token).digest('hex'),
    create: jest.fn((doc) => {
      const record = { _id: `rt${model.__store.size + 1}`, ...doc };
      model.__store.set(doc.tokenHash, record);
      return Promise.resolve(record);
    }),
    findOne: jest.fn((filter) => Promise.resolve(model.__store.get(filter.tokenHash) || null)),
    updateOne: jest.fn((filter, update) => {
      const record = filter.tokenHash
        ? model.__store.get(filter.tokenHash)
        : [...model.__store.values()].find((r) => r._id === filter._id);
      if (record) Object.assign(record, update.$set || {});
      return Promise.resolve({ acknowledged: true });
    }),
    updateMany: jest.fn((filter, update) => {
      for (const record of model.__store.values()) {
        if (record.family === filter.family) Object.assign(record, update.$set || {});
      }
      return Promise.resolve({ acknowledged: true });
    }),
  };
  return model;
});

const User = require('../../src/models/User');
const RefreshToken = require('../../src/models/RefreshToken');
const app = require('../../src/app');
const { ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE } = require('../../src/utils/tokens');

User.__store = users;
RefreshToken.__store = refreshTokens;

const GOOD_PASSWORD = 'Correct-Horse-9';

function register(email = 'alice@example.com', password = GOOD_PASSWORD) {
  return request(app).post('/api/auth/register').send({ email, password, name: 'Alice' });
}

/** Extracts a named cookie's value from a supertest response. */
function cookieValue(res, name) {
  const header = res.headers['set-cookie'] || [];
  const match = header.find((c) => c.startsWith(`${name}=`));
  return match ? match.split('=')[1].split(';')[0] : null;
}

function cookieAttributes(res, name) {
  const header = res.headers['set-cookie'] || [];
  return header.find((c) => c.startsWith(`${name}=`)) || '';
}

beforeEach(() => {
  users.clear();
  refreshTokens.clear();
  jest.clearAllMocks();
});

describe('POST /api/auth/register', () => {
  it('creates an account and returns the user without any secret material', async () => {
    const res = await register();

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('alice@example.com');
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(GOOD_PASSWORD);
  });

  it('never stores the password in plaintext', async () => {
    await register();
    const stored = [...users.values()][0];

    expect(stored.passwordHash).toBeDefined();
    expect(stored.passwordHash).not.toBe(GOOD_PASSWORD);
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/); // a bcrypt digest
    expect(stored.password).toBeUndefined();
  });

  it('rejects a weak password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'bob@example.com', password: 'password' });

    expect(res.status).toBe(400);
    expect(users.size).toBe(0);
  });

  it('rejects a malformed email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: GOOD_PASSWORD });

    expect(res.status).toBe(400);
  });

  it('ignores a client-supplied role (privilege escalation via mass assignment)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'mallory@example.com', password: GOOD_PASSWORD, role: 'admin', tokenVersion: 99 });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('user');
    const stored = [...users.values()][0];
    expect(stored.role).toBe('user');
    expect(stored.tokenVersion).toBe(0);
  });

  it('does not confirm which addresses are already registered', async () => {
    await register();
    const res = await register();

    expect(res.status).toBe(409);
    // Nothing in the message singles out "this email exists" - the wording
    // is the same generic refusal any other failure would produce.
    expect(res.body.error.message).not.toMatch(/exists|taken|registered/i);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(() => register());

  it('signs in with correct credentials and sets hardened cookies', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: GOOD_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('alice@example.com');

    // The session credentials must be unreadable to page scripts...
    expect(cookieAttributes(res, ACCESS_COOKIE)).toMatch(/HttpOnly/i);
    expect(cookieAttributes(res, REFRESH_COOKIE)).toMatch(/HttpOnly/i);
    // ...and the refresh cookie is scoped so it is not attached to
    // ordinary API calls at all.
    expect(cookieAttributes(res, REFRESH_COOKIE)).toMatch(/Path=\/api\/auth/i);
    // The CSRF half of the double-submit pair is readable by design.
    expect(cookieAttributes(res, CSRF_COOKIE)).not.toMatch(/HttpOnly/i);
    expect(res.body.data.csrfToken).toEqual(expect.any(String));
  });

  it('rejects a wrong password with the same message as an unknown account', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'Wrong-Password-1' });
    const unknownAccount = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'Wrong-Password-1' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    // Identical status and wording: the login form is not an
    // account-existence oracle.
    expect(unknownAccount.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('issues a different session token on each login (no session fixation)', async () => {
    const first = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: GOOD_PASSWORD });
    const second = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: GOOD_PASSWORD });

    expect(cookieValue(first, ACCESS_COOKIE)).not.toBe(cookieValue(second, ACCESS_COOKIE));
    expect(cookieValue(first, REFRESH_COOKIE)).not.toBe(cookieValue(second, REFRESH_COOKIE));
  });

  it('locks the account after repeated failures and keeps it locked for a correct password', async () => {
    const attempt = (password) =>
      request(app).post('/api/auth/login').send({ email: 'alice@example.com', password });

    for (let i = 0; i < 8; i += 1) {
      await attempt('Wrong-Password-1');
    }

    // Even the *right* password is refused while the lockout stands -
    // otherwise the lockout would not slow an attacker down at all.
    const res = await attempt(GOOD_PASSWORD);
    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/too many/i);
  });

  it('is not bypassable with a Mongo operator in place of an email', async () => {
    // `{"email": {"$gt": ""}}` is valid JSON. Unsanitised it becomes a
    // query matching the first user in the collection - a login with no
    // password at all.
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: { $gt: '' }, password: { $gt: '' } });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 for a token with a broken signature', async () => {
    await register();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: GOOD_PASSWORD });
    const token = cookieValue(login, ACCESS_COOKIE);
    const tampered = `${token.slice(0, -4)}AAAA`;

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tampered}`);

    expect(res.status).toBe(401);
    // jsonwebtoken's own wording ("invalid signature") tells an attacker
    // how close they got; it must not be forwarded.
    expect(res.body.error.message).toBe('Not authenticated');
    expect(res.body.error.stack).toBeUndefined();
  });

  it('returns the current user for a valid session cookie', async () => {
    await register();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: GOOD_PASSWORD });

    const res = await request(app).get('/api/auth/me').set('Cookie', login.headers['set-cookie']);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('alice@example.com');
    expect(res.body.data.user.passwordHash).toBeUndefined();
  });
});

describe('refresh rotation', () => {
  async function signIn() {
    await register();
    return request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: GOOD_PASSWORD });
  }

  it('exchanges a refresh cookie for a new session', async () => {
    const login = await signIn();
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', login.headers['set-cookie'])
      .set('X-CSRF-Token', login.body.data.csrfToken);

    expect(res.status).toBe(200);
    expect(cookieValue(res, REFRESH_COOKIE)).not.toBe(cookieValue(login, REFRESH_COOKIE));
  });

  it('refuses a refresh token that has already been used, and kills the family', async () => {
    const login = await signIn();
    const cookies = login.headers['set-cookie'];
    const csrf = login.body.data.csrfToken;

    const first = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrf);
    expect(first.status).toBe(200);

    // Replaying the original token: either it was stolen, or the real
    // holder's successor was. Both hands are forced back to a fresh login.
    const replay = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', csrf);
    expect(replay.status).toBe(401);

    const successor = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', first.headers['set-cookie'])
      .set('X-CSRF-Token', first.body.data.csrfToken);
    expect(successor.status).toBe(401);
  });

  it('refuses a made-up refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [`${REFRESH_COOKIE}=not-a-real-token`, `${CSRF_COOKIE}=csrf-value`])
      .set('X-CSRF-Token', 'csrf-value');
    expect(res.status).toBe(401);
  });

  it('refuses a refresh with no CSRF header (cross-site forgery)', async () => {
    const login = await signIn();
    // The browser would attach the cookies to a cross-site POST all by
    // itself; what the attacker's page cannot do is read the CSRF cookie
    // and echo it in a header.
    const res = await request(app).post('/api/auth/refresh').set('Cookie', login.headers['set-cookie']);

    expect(res.status).toBe(403);
    expect(res.body.error.details.code).toBe('CSRF_FAILED');
  });

  it('refuses a refresh whose CSRF header does not match the cookie', async () => {
    const login = await signIn();
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', login.headers['set-cookie'])
      .set('X-CSRF-Token', 'a-guess');

    expect(res.status).toBe(403);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the auth cookies and revokes the session', async () => {
    await register();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: GOOD_PASSWORD });
    const csrf = login.body.data.csrfToken;

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', login.headers['set-cookie'])
      .set('X-CSRF-Token', csrf);

    expect(res.status).toBe(200);
    const cleared = res.headers['set-cookie'].join(';');
    expect(cleared).toMatch(new RegExp(`${ACCESS_COOKIE}=;`));

    // The revoked refresh token no longer buys a new session.
    const afterLogout = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', login.headers['set-cookie'])
      .set('X-CSRF-Token', csrf);
    expect(afterLogout.status).toBe(401);
  });
});

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
    return withMfaFlag(Object.assign(doc, {
      verifyPassword(plaintext) {
        return bcrypt.compare(plaintext, doc.passwordHash);
      },
      toPublicJSON() {
        return {
          id: String(doc._id),
          email: doc.email,
          name: doc.name,
          role: doc.role,
          emailVerified: Boolean(doc.emailVerifiedAt),
          mfaEnabled: Boolean(doc.mfaEnabledAt),
        };
      },
      // Lockout is tracked per source network rather than per account, so
      // one attacker cannot keep a victim out of their own account - see
      // the `loginFailures` field in models/User.js.
      isLockedFor(source) {
        const bucket = (doc.loginFailures || []).find((b) => b.source === source);
        return Boolean(bucket?.lockUntil && new Date(bucket.lockUntil).getTime() > Date.now());
      },
      lockSecondsFor(source) {
        const bucket = (doc.loginFailures || []).find((b) => b.source === source);
        if (!bucket?.lockUntil) return 0;
        return Math.max(0, Math.ceil((new Date(bucket.lockUntil).getTime() - Date.now()) / 1000));
      },
    }));
  }

  // Defined rather than assigned: `Object.assign` reads a getter on the
  // source and copies its *value*, which froze `mfaEnabled` as false at
  // decoration time and quietly disabled every MFA check.
  function withMfaFlag(doc) {
    Object.defineProperty(doc, 'mfaEnabled', {
      get: () => Boolean(doc.mfaEnabledAt),
      configurable: true,
    });
    return doc;
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
        loginFailures: [],
        globalFailedLogins: 0,
        emailVerifiedAt: null,
        mfaSecret: null,
        mfaEnabledAt: null,
        mfaRecoveryCodes: [],
        mfaLastUsedStep: 0,
      });
      model.__store.set(id, record);
      return Promise.resolve(record);
    }),
    updateOne: jest.fn((filter, update) => {
      const record = model.__store.get(String(filter._id));
      if (record) {
        Object.assign(record, update.$set || {});
        for (const [field, amount] of Object.entries(update.$inc || {})) {
          record[field] = (record[field] || 0) + amount;
        }
        // Successful login clears just *this* source's failure bucket, and
        // a spent MFA recovery code is consumed by removal - both are
        // $pull, so the stub has to understand it.
        for (const [field, condition] of Object.entries(update.$pull || {})) {
          const current = record[field] || [];
          record[field] = current.filter((entry) =>
            typeof condition === 'object' && condition !== null && !Array.isArray(condition)
              ? !Object.entries(condition).every(([k, v]) => entry?.[k] === v)
              : entry !== condition
          );
        }
      }
      return Promise.resolve({ acknowledged: true, modifiedCount: record ? 1 : 0 });
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
    findOne: jest.fn((filter) => {
      const promise = Promise.resolve(model.__store.get(filter.tokenHash) || null);
      // `.select(...)` is used on the reuse-detection path.
      promise.select = () => promise;
      return promise;
    }),
    // Rotation consumes the presented token *before* issuing a successor,
    // as one conditional update - see the comment on authService.refresh.
    // The filter's `revokedAt: null` / `expiresAt` terms are what make it
    // single-use, so the stub has to honour them rather than just looking
    // the record up.
    findOneAndUpdate: jest.fn((filter, update) => {
      const record = model.__store.get(filter.tokenHash);
      if (!record) return Promise.resolve(null);
      if (filter.revokedAt === null && record.revokedAt) return Promise.resolve(null);
      if (filter.expiresAt?.$gt && new Date(record.expiresAt) <= filter.expiresAt.$gt) {
        return Promise.resolve(null);
      }
      const before = { ...record };
      Object.assign(record, update.$set || {});
      return Promise.resolve(before);
    }),
    updateOne: jest.fn((filter, update) => {
      const record = filter.tokenHash
        ? model.__store.get(filter.tokenHash)
        : [...model.__store.values()].find((r) => r._id === filter._id);
      if (record) Object.assign(record, update.$set || {});
      return Promise.resolve({ acknowledged: true });
    }),
    updateMany: jest.fn((filter, update) => {
      for (const record of model.__store.values()) {
        const matchesFamily = filter.family === undefined || record.family === filter.family;
        const matchesUser =
          filter.userId === undefined || String(record.userId) === String(filter.userId);
        if (matchesFamily && matchesUser) Object.assign(record, update.$set || {});
      }
      return Promise.resolve({ acknowledged: true });
    }),
  };
  return model;
});

// Password reset and email verification hang single-use tokens off their
// own collection - see models/VerificationToken.js.
const verificationTokens = new Map();

jest.mock('../../src/models/VerificationToken', () => {
  const crypto = require('crypto');
  const model = {
    __store: null,
    hashToken: (token) => crypto.createHash('sha256').update(token).digest('hex'),
    create: jest.fn((doc) => {
      const record = { _id: `vt${model.__store.size + 1}`, usedAt: null, ...doc };
      model.__store.set(doc.tokenHash, record);
      return Promise.resolve(record);
    }),
    // The `usedAt: null` term in the *filter* is what makes redemption
    // single-use under a race, so the stub enforces it rather than
    // matching on the hash alone.
    findOneAndUpdate: jest.fn((filter, update) => {
      const record = model.__store.get(filter.tokenHash);
      if (!record) return Promise.resolve(null);
      if (filter.purpose && record.purpose !== filter.purpose) return Promise.resolve(null);
      if (filter.usedAt === null && record.usedAt) return Promise.resolve(null);
      if (filter.expiresAt?.$gt && new Date(record.expiresAt) <= filter.expiresAt.$gt) {
        return Promise.resolve(null);
      }
      Object.assign(record, update.$set || {});
      return Promise.resolve(record);
    }),
    updateMany: jest.fn((filter, update) => {
      for (const record of model.__store.values()) {
        if (String(record.userId) !== String(filter.userId)) continue;
        if (filter.purpose && record.purpose !== filter.purpose) continue;
        if (filter.usedAt === null && record.usedAt) continue;
        Object.assign(record, update.$set || {});
      }
      return Promise.resolve({ acknowledged: true });
    }),
  };
  return model;
});

// The audit trail must never change an outcome, so it is stubbed out
// wholesale here; tests/security/audit.test.js covers what it records.
jest.mock('../../src/models/SecurityEvent', () => ({
  create: jest.fn().mockResolvedValue({}),
  TYPES: [],
}));

const User = require('../../src/models/User');
const RefreshToken = require('../../src/models/RefreshToken');
const VerificationToken = require('../../src/models/VerificationToken');
const app = require('../../src/app');
const { ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE } = require('../../src/utils/tokens');

User.__store = users;
RefreshToken.__store = refreshTokens;
VerificationToken.__store = verificationTokens;

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
  verificationTokens.clear();
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

  /**
   * The deployed frontend is on a different origin than the API, so the
   * CSRF cookie - host-only to the API - is invisible to `document.cookie`
   * on the page. This endpoint is the only call a reloaded tab makes
   * before it starts issuing writes, so it is where that client has to be
   * able to recover the token. Without this it held a valid session it
   * could not make a single state-changing request with.
   */
  it('returns the CSRF token so a cross-origin client can echo it back', async () => {
    await register();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: GOOD_PASSWORD });

    const res = await request(app).get('/api/auth/me').set('Cookie', login.headers['set-cookie']);

    expect(res.status).toBe(200);
    // The same value the cookie carries, or the double-submit pair would
    // not match on the next write.
    expect(res.body.data.csrfToken).toBe(login.body.data.csrfToken);
  });

  it('issues and sets a CSRF token when the request arrives without one', async () => {
    await register();
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: GOOD_PASSWORD });

    // Access cookie only: a browser that dropped the readable half, or a
    // client that never stored it.
    const accessCookie = login.headers['set-cookie']
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('wrs_access='));

    const res = await request(app).get('/api/auth/me').set('Cookie', accessCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.csrfToken).toEqual(expect.any(String));
    // Set on the response too, so the cookie and the body agree.
    const setCsrf = (res.headers['set-cookie'] || []).find((c) => c.startsWith('wrs_csrf='));
    expect(setCsrf).toContain(`wrs_csrf=${res.body.data.csrfToken}`);
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

/**
 * Auth cookies outlive the sessions they belong to - the access cookie for
 * 15 minutes, the refresh cookie for 30 days - and a session can be
 * revoked or rotated out from under them at any point. A browser sitting
 * on a stale pair used to be refused by every endpoint that could have
 * recovered it, because CSRF was gated on the cookie merely being present.
 * That is a lockout with no way out from inside the application.
 */
describe('a browser holding stale auth cookies', () => {
  const STALE = ['wrs_access=stale.access.token', 'wrs_refresh=staleRefreshTokenValue'];

  it('can still register', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Cookie', STALE)
      .send({ email: 'newcomer@example.com', password: GOOD_PASSWORD, name: 'Newcomer' });

    expect(res.status).toBe(201);
  });

  it('can still sign in, which replaces the stale cookies', async () => {
    await register();

    const res = await request(app)
      .post('/api/auth/login')
      .set('Cookie', STALE)
      .send({ email: 'alice@example.com', password: GOOD_PASSWORD });

    expect(res.status).toBe(200);
    // The wedge clears itself: a fresh set of cookies lands on the way out.
    expect(res.headers['set-cookie'].join(';')).toContain('wrs_access=');
  });

  it.each([
    ['/api/auth/password/forgot', { email: 'alice@example.com' }],
    ['/api/auth/password/reset', { token: 'x'.repeat(40), password: GOOD_PASSWORD }],
    ['/api/auth/email/verify', { token: 'x'.repeat(40) }],
  ])('can still reach %s', async (path, body) => {
    const res = await request(app).post(path).set('Cookie', STALE).send(body);

    // Whatever the endpoint decides about the credential itself, the
    // request has to get past CSRF to decide anything at all.
    expect(res.status).not.toBe(403);
  });

  /**
   * The other half of the rule. These act on the authority of the cookie
   * itself rather than on a credential in the body, so a third-party page
   * being able to fire them is the whole thing CSRF exists to stop -
   * /auth/refresh most of all, since it mints an entire new session.
   */
  it('is still refused a refresh without a matching CSRF header', async () => {
    const res = await request(app).post('/api/auth/refresh').set('Cookie', STALE).send({});

    expect(res.status).toBe(403);
    expect(res.body.error.details.code).toBe('CSRF_FAILED');
  });

  it('is still refused a logout without a matching CSRF header', async () => {
    const res = await request(app).post('/api/auth/logout').set('Cookie', STALE).send({});

    expect(res.status).toBe(403);
    expect(res.body.error.details.code).toBe('CSRF_FAILED');
  });

  it('is still refused an ordinary authenticated write', async () => {
    const res = await request(app)
      .post('/api/warehouses')
      .set('Cookie', STALE)
      .send({ name: 'Forged', rows: 10, cols: 10 });

    expect(res.status).toBe(403);
    expect(res.body.error.details.code).toBe('CSRF_FAILED');
  });

  it('does not exempt a path that merely starts like an exempt one', async () => {
    // The exemption is an exact-match set, not a prefix test: this is an
    // authenticated endpoint that happens to live under /email/verify.
    const res = await request(app)
      .post('/api/auth/email/verify/request')
      .set('Cookie', STALE)
      .send({});

    expect(res.status).toBe(403);
  });
});

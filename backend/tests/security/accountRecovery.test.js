/**
 * Password reset, email verification and MFA - the three flows that were
 * listed as out of scope on the grounds that there was no email
 * infrastructure.
 *
 * That reason only ever covered the *delivery*. What matters here is the
 * token handling, because a password reset is an authentication bypass by
 * design: whoever holds a valid token becomes the user. So these tests are
 * mostly about the ways a token must stop working.
 *
 * Same approach as auth.test.js: the real User model methods over an
 * in-memory store, because a test that mocks out password hashing proves
 * nothing about password hashing.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');

const users = new Map();
const verificationTokens = new Map();
const refreshTokens = new Map();

jest.mock('../../src/models/User', () => {
  const bcryptLib = require('bcryptjs');
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function decorate(doc) {
    return withMfaFlag(Object.assign(doc, {
      verifyPassword(plaintext) {
        return bcryptLib.compare(plaintext, doc.passwordHash);
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
      isLockedFor() {
        return false;
      },
      lockSecondsFor() {
        return 0;
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
    __store: null,
    __decorate: decorate,
    hashPassword: (plaintext) => bcryptLib.hash(plaintext, 4),
    findById: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn((filter, update) => {
      const record = model.__store.get(String(filter._id));
      if (!record) return Promise.resolve({ modifiedCount: 0 });
      // The MFA recovery-code consume is a conditional update: it only
      // matches while the code is still present, which is what stops two
      // racing requests both spending it.
      if (filter.mfaRecoveryCodes && !(record.mfaRecoveryCodes || []).includes(filter.mfaRecoveryCodes)) {
        return Promise.resolve({ modifiedCount: 0 });
      }
      Object.assign(record, update.$set || {});
      for (const [field, amount] of Object.entries(update.$inc || {})) {
        record[field] = (record[field] || 0) + amount;
      }
      for (const [field, condition] of Object.entries(update.$pull || {})) {
        const current = record[field] || [];
        record[field] = current.filter((entry) =>
          typeof condition === 'object' && condition !== null && !Array.isArray(condition)
            ? !Object.entries(condition).every(([k, v]) => entry?.[k] === v)
            : entry !== condition
        );
      }
      return Promise.resolve({ modifiedCount: 1 });
    }),
    updateMany: jest.fn().mockResolvedValue({ acknowledged: true }),
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
    EMAIL_PATTERN,
    ROLES: ['user', 'admin'],
  };

  // Both are used with and without `.select(...)`.
  const selectable = (resolve) =>
    jest.fn((...args) => {
      const promise = Promise.resolve(resolve(...args));
      // @ts-ignore
      promise.select = () => promise;
      return promise;
    });
  model.findById = selectable((id) => model.__store.get(String(id)) || null);
  model.findOne = selectable((filter = {}) => {
    const email = typeof filter.email === 'string' ? filter.email.toLowerCase() : null;
    if (!email) return null;
    return [...model.__store.values()].find((u) => u.email === email) || null;
  });

  return model;
});

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
    findOne: jest.fn(() => {
      const promise = Promise.resolve(null);
      // @ts-ignore
      promise.select = () => promise;
      return promise;
    }),
    findOneAndUpdate: jest.fn().mockResolvedValue(null),
    updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    updateMany: jest.fn((filter, update) => {
      for (const record of model.__store.values()) {
        if (filter.userId && String(record.userId) !== String(filter.userId)) continue;
        Object.assign(record, update.$set || {});
      }
      return Promise.resolve({ acknowledged: true });
    }),
  };
  return model;
});

jest.mock('../../src/models/SecurityEvent', () => ({
  create: jest.fn().mockResolvedValue({}),
  TYPES: [],
}));

const User = require('../../src/models/User');
const VerificationToken = require('../../src/models/VerificationToken');
const RefreshToken = require('../../src/models/RefreshToken');
const totp = require('../../src/utils/totp');
const app = require('../../src/app');

User.__store = users;
VerificationToken.__store = verificationTokens;
RefreshToken.__store = refreshTokens;

const PASSWORD = 'Correct-Horse-9';
const NEW_PASSWORD = 'Different-Horse-4';

async function registerUser(email = 'alice@example.com') {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: PASSWORD, name: 'Alice' });
  return res;
}

/** Pulls a named cookie out of a supertest response, and the CSRF token
 * that has to be echoed back on every cookie-authenticated write. */
function session(res) {
  const header = res.headers['set-cookie'] || [];
  return {
    cookie: header.map((c) => c.split(';')[0]).join('; '),
    csrf: res.body.data.csrfToken,
  };
}

function asUser(req, s) {
  return req.set('Cookie', s.cookie).set('x-csrf-token', s.csrf);
}

beforeEach(() => {
  users.clear();
  verificationTokens.clear();
  refreshTokens.clear();
  jest.clearAllMocks();
});

describe('POST /api/auth/password/forgot', () => {
  it('answers identically for an address with and without an account', async () => {
    await registerUser('alice@example.com');

    const known = await request(app)
      .post('/api/auth/password/forgot')
      .send({ email: 'alice@example.com' });
    const unknown = await request(app)
      .post('/api/auth/password/forgot')
      .send({ email: 'nobody@example.com' });

    // A "we couldn't find that email" would make this a better
    // account-existence oracle than the login form, which goes to real
    // trouble not to be one.
    expect(known.status).toBe(unknown.status);
    expect(known.body.data.message).toBe(unknown.body.data.message);
  });

  it('issues no token at all for an unknown address', async () => {
    await request(app).post('/api/auth/password/forgot').send({ email: 'nobody@example.com' });
    expect(VerificationToken.create).not.toHaveBeenCalled();
  });

  it('supersedes an outstanding token, so an older link stops working', async () => {
    await registerUser();
    const first = await request(app)
      .post('/api/auth/password/forgot')
      .send({ email: 'alice@example.com' });
    await request(app).post('/api/auth/password/forgot').send({ email: 'alice@example.com' });

    // Without superseding, every "resend" leaves another live credential
    // in another inbox.
    const res = await request(app)
      .post('/api/auth/password/reset')
      .send({ token: first.body.data.token, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/password/reset', () => {
  async function requestReset(email = 'alice@example.com') {
    const res = await request(app).post('/api/auth/password/forgot').send({ email });
    return res.body.data.token;
  }

  it('sets the new password and signs the user in', async () => {
    await registerUser();
    const token = await requestReset();

    const res = await request(app)
      .post('/api/auth/password/reset')
      .send({ token, password: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'].join(';')).toMatch(/wrs_access=/);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: NEW_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('makes the old password stop working', async () => {
    await registerUser();
    const token = await requestReset();
    await request(app).post('/api/auth/password/reset').send({ token, password: NEW_PASSWORD });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('is single use', async () => {
    await registerUser();
    const token = await requestReset();
    await request(app).post('/api/auth/password/reset').send({ token, password: NEW_PASSWORD });

    const second = await request(app)
      .post('/api/auth/password/reset')
      .send({ token, password: 'Third-Password-7' });
    expect(second.status).toBe(400);
  });

  it('revokes every existing session', async () => {
    // A reset is what someone does when they think their account is
    // compromised. Leaving the attacker's refresh cookie working would
    // defeat the point of doing it.
    await registerUser();
    const token = await requestReset();
    await request(app).post('/api/auth/password/reset').send({ token, password: NEW_PASSWORD });

    expect(RefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ revokedAt: null }),
      expect.objectContaining({ $set: expect.objectContaining({ revokedAt: expect.any(Date) }) })
    );
    // ...and outstanding access tokens with it, via tokenVersion.
    expect([...users.values()][0].tokenVersion).toBeGreaterThan(0);
  });

  it('rejects an expired token', async () => {
    await registerUser();
    const token = await requestReset();
    for (const record of verificationTokens.values()) {
      record.expiresAt = new Date(Date.now() - 1000);
    }

    const res = await request(app)
      .post('/api/auth/password/reset')
      .send({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it('rejects a fabricated token', async () => {
    const res = await request(app)
      .post('/api/auth/password/reset')
      .send({ token: 'a'.repeat(64), password: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it('stops working if the account\'s address changed after it was issued', async () => {
    // Otherwise a link mailed to a stale (or attacker-controlled) address
    // still opens the account after the address is corrected - which is
    // precisely the takeover a reset flow exists to prevent.
    await registerUser();
    const token = await requestReset();
    [...users.values()][0].email = 'alice-new@example.com';

    const res = await request(app)
      .post('/api/auth/password/reset')
      .send({ token, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it('enforces password strength on the new password', async () => {
    await registerUser();
    const token = await requestReset();
    const res = await request(app).post('/api/auth/password/reset').send({ token, password: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/password/change', () => {
  it('requires the current password', async () => {
    // A session left open on a shared machine must not be enough to lock
    // the real owner out.
    const registered = await registerUser();
    const s = session(registered);

    const res = await asUser(request(app).post('/api/auth/password/change'), s).send({
      currentPassword: 'Not-The-Password-1',
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(401);
  });

  it('changes the password and re-issues the session', async () => {
    const registered = await registerUser();
    const s = session(registered);

    const res = await asUser(request(app).post('/api/auth/password/change'), s).send({
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(res.status).toBe(200);
    // Changing a password revokes every other session, so the caller needs
    // a fresh pair or their own next request would fail.
    expect(res.headers['set-cookie'].join(';')).toMatch(/wrs_access=/);
  });

  it('refuses a "change" to the same password', async () => {
    const registered = await registerUser();
    const s = session(registered);

    const res = await asUser(request(app).post('/api/auth/password/change'), s).send({
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    });
    expect(res.status).toBe(400);
  });
});

describe('email verification', () => {
  it('starts unverified and reports it', async () => {
    const res = await registerUser();
    expect(res.body.data.user.emailVerified).toBe(false);
  });

  it('confirms the address with the emailed token', async () => {
    const registered = await registerUser();
    const s = session(registered);

    const requested = await asUser(request(app).post('/api/auth/email/verify/request'), s).send({});
    const res = await request(app)
      .post('/api/auth/email/verify')
      .send({ token: requested.body.data.token });

    expect(res.status).toBe(200);

    const me = await request(app).get('/api/auth/me').set('Cookie', s.cookie);
    expect(me.body.data.user.emailVerified).toBe(true);
  });

  it('does not require a session to follow the link', async () => {
    // The link is followed from an email client, which is frequently not
    // the browser holding the session.
    const registered = await registerUser();
    const s = session(registered);
    const requested = await asUser(request(app).post('/api/auth/email/verify/request'), s).send({});

    const res = await request(app)
      .post('/api/auth/email/verify')
      .send({ token: requested.body.data.token });
    expect(res.status).toBe(200);
  });

  it('is single use', async () => {
    const registered = await registerUser();
    const s = session(registered);
    const requested = await asUser(request(app).post('/api/auth/email/verify/request'), s).send({});

    await request(app).post('/api/auth/email/verify').send({ token: requested.body.data.token });
    const second = await request(app)
      .post('/api/auth/email/verify')
      .send({ token: requested.body.data.token });
    expect(second.status).toBe(400);
  });

  it('will not accept a verification token on the reset endpoint', async () => {
    // Purpose is part of the filter, not just a label: a token minted for
    // one flow must not be redeemable in another, or the weaker flow
    // becomes a way into the stronger one.
    const registered = await registerUser();
    const s = session(registered);
    const requested = await asUser(request(app).post('/api/auth/email/verify/request'), s).send({});

    const res = await request(app)
      .post('/api/auth/password/reset')
      .send({ token: requested.body.data.token, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it('a completed password reset also verifies the address', async () => {
    // Proving control of the mailbox is at least as strong as clicking a
    // confirmation link in it.
    await registerUser();
    const forgot = await request(app)
      .post('/api/auth/password/forgot')
      .send({ email: 'alice@example.com' });
    await request(app)
      .post('/api/auth/password/reset')
      .send({ token: forgot.body.data.token, password: NEW_PASSWORD });

    expect([...users.values()][0].emailVerifiedAt).toBeTruthy();
  });
});

describe('multi-factor authentication', () => {
  /**
   * A code for the *next* 30-second step.
   *
   * Confirming enrolment consumes the step it was confirmed with, so a
   * code generated a moment later is the same six digits and is correctly
   * refused as a replay. In life that is thirty seconds of waiting; here
   * it is one step forward, which `verify`'s ±1 window still accepts.
   */
  function nextCode(secret) {
    return totp.generate(secret, Date.now() + totp.STEP_SECONDS * 1000);
  }

  async function enrol() {
    const registered = await registerUser();
    const s = session(registered);
    const setup = await asUser(request(app).post('/api/auth/mfa/setup'), s).send({});
    const { secret } = setup.body.data;
    const enabled = await asUser(request(app).post('/api/auth/mfa/enable'), s).send({
      code: totp.generate(secret),
    });
    return { s, secret, recoveryCodes: enabled.body.data.recoveryCodes };
  }

  it('does not enforce anything until enrolment is confirmed', async () => {
    // A user who scans a code, loses the phone, and finds MFA already
    // required would be locked out by the act of setting it up.
    const registered = await registerUser();
    const s = session(registered);
    await asUser(request(app).post('/api/auth/mfa/setup'), s).send({});

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it('returns an otpauth URI an authenticator app can scan', async () => {
    const registered = await registerUser();
    const s = session(registered);
    const res = await asUser(request(app).post('/api/auth/mfa/setup'), s).send({});

    expect(res.body.data.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.data.otpauthUri).toContain('digits=6');
    expect(res.body.data.otpauthUri).toContain('period=30');
  });

  it('rejects enrolment with a wrong code', async () => {
    const registered = await registerUser();
    const s = session(registered);
    await asUser(request(app).post('/api/auth/mfa/setup'), s).send({});

    const res = await asUser(request(app).post('/api/auth/mfa/enable'), s).send({ code: '000000' });
    expect(res.status).toBe(400);
  });

  it('hands back recovery codes exactly once, and stores only digests', async () => {
    const { recoveryCodes } = await enrol();
    expect(recoveryCodes).toHaveLength(10);

    const stored = [...users.values()][0].mfaRecoveryCodes;
    expect(stored).toHaveLength(10);
    for (const hash of stored) expect(hash).not.toBe(recoveryCodes[0]);
    expect(await bcrypt.compare(recoveryCodes[0], stored[0])).toBe(true);
  });

  it('refuses a password-only login once enabled', async () => {
    await enrol();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD });

    expect(res.status).toBe(401);
    // The password has already been proven at this point, so there is
    // nothing left to enumerate - being vague would only confuse a
    // legitimate user.
    expect(res.body.error.details.code).toBe('MFA_REQUIRED');
  });

  it('accepts a login with a current code', async () => {
    const { secret } = await enrol();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD, mfaCode: nextCode(secret) });
    expect(res.status).toBe(200);
  });

  it('refuses to replay the same code inside its own window', async () => {
    // A code is valid for a whole 30-second step plus a window either
    // side, so without recording the accepted step the same six digits -
    // shoulder-surfed, or relayed by a phishing page - would work twice.
    const { secret } = await enrol();
    const code = nextCode(secret);

    await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD, mfaCode: code });
    const replay = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD, mfaCode: code });

    expect(replay.status).toBe(401);
    expect(replay.body.error.details.code).toBe('MFA_REPLAY');
  });

  it('accepts a recovery code, and only once', async () => {
    const { recoveryCodes } = await enrol();

    const first = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD, recoveryCode: recoveryCodes[0] });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: PASSWORD, recoveryCode: recoveryCodes[0] });
    expect(second.status).toBe(401);
  });

  it('still refuses a wrong password even with a valid code', async () => {
    const { secret } = await enrol();
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: 'alice@example.com',
        password: 'Wrong-Password-1',
        mfaCode: nextCode(secret),
      });
    expect(res.status).toBe(401);
  });

  it('requires the password and a factor to turn it off', async () => {
    // Turning a protection off has to be at least as hard as using it, or
    // an attacker with a live session simply removes it.
    const { s, secret } = await enrol();

    const noFactor = await asUser(request(app).post('/api/auth/mfa/disable'), s).send({
      password: PASSWORD,
    });
    expect(noFactor.status).toBe(401);

    const wrongPassword = await asUser(request(app).post('/api/auth/mfa/disable'), s).send({
      password: 'Wrong-Password-1',
      code: nextCode(secret),
    });
    expect(wrongPassword.status).toBe(401);

    const ok = await asUser(request(app).post('/api/auth/mfa/disable'), s).send({
      password: PASSWORD,
      code: nextCode(secret),
    });
    expect(ok.status).toBe(200);
  });
});

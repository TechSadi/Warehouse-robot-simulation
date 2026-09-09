/**
 * The administrative surface and the audit trail behind it.
 *
 * `requireRole` was implemented and no route used it, which made `admin` a
 * field on a model rather than a capability - and left the security events
 * this phase records with no way to read them. What matters most here is
 * the *shape* of the admin surface: it can see about users, and never act
 * as them, because an admin bypass would make every ownership check in the
 * application conditional on a role.
 */
const request = require('supertest');

jest.mock('../../src/models/User', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
  countDocuments: jest.fn().mockResolvedValue(0),
  EMAIL_PATTERN: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  ROLES: ['user', 'admin'],
}));

jest.mock('../../src/models/Warehouse', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn().mockResolvedValue(0),
  CELL_TYPES: ['shelf', 'charging', 'obstacle', 'dock'],
}));

jest.mock('../../src/models/RefreshToken', () => ({
  countDocuments: jest.fn().mockResolvedValue(0),
  updateMany: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
}));

jest.mock('../../src/models/SecurityEvent', () => {
  const events = [];
  return {
    __events: events,
    create: jest.fn((doc) => {
      events.push(doc);
      return Promise.resolve(doc);
    }),
    find: jest.fn(),
    countDocuments: jest.fn().mockResolvedValue(0),
    TYPES: ['login_failed', 'admin_action', 'authorization_denied'],
  };
});

const User = require('../../src/models/User');
const SecurityEvent = require('../../src/models/SecurityEvent');
const audit = require('../../src/services/securityAudit');
const app = require('../../src/app');
const { mockQuery } = require('../helpers/mockQuery');
const { makeUser, tokenFor, USER_A_ID, USER_B_ID } = require('../helpers/auth');

const ADMIN = makeUser(USER_A_ID, { role: 'admin' });
const PLAIN = makeUser(USER_B_ID, { role: 'user' });

function asAdmin(req) {
  return req.set('Authorization', `Bearer ${tokenFor(ADMIN)}`);
}
function asUser(req) {
  return req.set('Authorization', `Bearer ${tokenFor(PLAIN)}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  SecurityEvent.__events.length = 0;
  User.findById.mockImplementation((id) => {
    const doc = String(id) === USER_A_ID ? ADMIN : String(id) === USER_B_ID ? PLAIN : null;
    const promise = Promise.resolve(doc);
    // @ts-ignore - the admin controller narrows with .select(...)
    promise.select = () => Promise.resolve(doc);
    return promise;
  });
  User.find.mockReturnValue(mockQuery([]));
  SecurityEvent.find.mockReturnValue(mockQuery([]));
});

describe('access to /api/admin', () => {
  it('refuses an anonymous caller with 401', async () => {
    // "You are not signed in" and "you are signed in and not allowed" are
    // genuinely different answers, and neither leaks anything: the routes
    // are not secret.
    const res = await request(app).get('/api/admin/users');
    expect(res.status).toBe(401);
  });

  it('refuses an ordinary signed-in user with 403', async () => {
    const res = await asUser(request(app).get('/api/admin/users'));
    expect(res.status).toBe(403);
  });

  it('admits an admin', async () => {
    const res = await asAdmin(request(app).get('/api/admin/users'));
    expect(res.status).toBe(200);
  });

  it('gates every route, not one by one', async () => {
    // A per-route opt-in fails by omission, and the failure mode here is
    // an administrative endpoint open to any signed-in user.
    for (const path of ['/api/admin/users', '/api/admin/security-events', '/api/admin/status']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await asUser(request(app).get(path));
      expect(res.status).toBe(403);
    }
  });
});

describe('what an admin can see', () => {
  it('never returns a password hash, MFA secret or recovery codes', async () => {
    // Not by filtering them out of the response but by never selecting
    // them, so a sensitive field added later is excluded by default.
    await asAdmin(request(app).get('/api/admin/users'));

    const projection = User.find.mock.results[0].value.select.mock.calls[0][0];
    expect(projection).not.toMatch(/passwordHash/);
    expect(projection).not.toMatch(/mfaSecret/);
    expect(projection).not.toMatch(/mfaRecoveryCodes/);
  });

  it('reports verification and MFA state for support questions', async () => {
    User.find.mockReturnValue(
      mockQuery([
        {
          _id: USER_B_ID,
          email: 'user@example.com',
          name: 'User',
          role: 'user',
          emailVerifiedAt: new Date(),
          mfaEnabledAt: null,
          globalFailedLogins: 3,
        },
      ])
    );

    const res = await asAdmin(request(app).get('/api/admin/users'));
    expect(res.body.data[0]).toMatchObject({
      email: 'user@example.com',
      emailVerified: true,
      mfaEnabled: false,
      failedLoginsAllTime: 3,
    });
  });
});

describe('what an admin cannot do', () => {
  it('has no route to read another user\'s warehouses', async () => {
    // Authorization here is ownership-based, and an admin bypass would
    // make every ownership check in the app conditional on a role.
    const res = await asAdmin(request(app).get(`/api/admin/users/${USER_B_ID}/warehouses`));
    expect(res.status).toBe(404);
  });

  it('has no route to set a password or impersonate', async () => {
    const impersonate = await asAdmin(
      request(app).post(`/api/admin/users/${USER_B_ID}/impersonate`).send({})
    );
    expect(impersonate.status).toBe(404);

    const setPassword = await asAdmin(
      request(app).post(`/api/admin/users/${USER_B_ID}/password`).send({ password: 'x' })
    );
    expect(setPassword.status).toBe(404);
  });

  it('still cannot reach another user\'s warehouse through the ordinary API', async () => {
    const Warehouse = require('../../src/models/Warehouse');
    Warehouse.findOne.mockResolvedValue(null); // not owned by, nor shared with, the admin
    const res = await asAdmin(request(app).get('/api/warehouses/507f1f77bcf86cd799439099'));
    expect(res.status).toBe(404);
  });
});

describe('revoking a user\'s sessions', () => {
  it('revokes refresh tokens, bumps tokenVersion and clears lockouts', async () => {
    const res = await asAdmin(
      request(app).post(`/api/admin/users/${USER_B_ID}/revoke-sessions`).send({})
    );

    expect(res.status).toBe(200);
    // The two halves of one support case: "my account was compromised"
    // needs the attacker's sessions gone, "I am locked out" needs the
    // counters cleared.
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: expect.anything() },
      { $inc: { tokenVersion: 1 }, $set: { loginFailures: [] } }
    );
  });

  it('records the action in the audit trail', async () => {
    await asAdmin(request(app).post(`/api/admin/users/${USER_B_ID}/revoke-sessions`).send({}));
    const recorded = SecurityEvent.__events.find((e) => e.type === 'admin_action');
    expect(recorded.detail).toMatchObject({ action: 'revoke_sessions' });
  });

  it('records even the reads - an admin reading the security log is a security event', async () => {
    await asAdmin(request(app).get('/api/admin/security-events'));
    expect(SecurityEvent.__events.some((e) => e.detail?.action === 'list_security_events')).toBe(true);
  });
});

describe('the audit trail itself', () => {
  it('truncates an address to a network, not a host', async () => {
    // The trail exists to spot patterns - one source sweeping many
    // accounts. Keeping full addresses would make it a log of where
    // individual people were when they signed in, which is a materially
    // more sensitive dataset than the one this is for.
    expect(audit.truncateIp('203.0.113.47')).toBe('203.0.113.0/24');
    expect(audit.truncateIp('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48');
    expect(audit.truncateIp('')).toBe('');
    expect(audit.truncateIp(undefined)).toBe('');
  });

  it('never lets a failed write change the outcome', async () => {
    // A failure to write an audit row must not turn a successful sign-in
    // into a 500 - or, worse, make a failed one behave observably
    // differently from a successful one.
    SecurityEvent.create.mockRejectedValueOnce(new Error('mongo is unhappy'));
    await expect(audit.record('login_failed', { email: 'a@example.com' })).resolves.toBeNull();
  });

  it('marks failures as failures without being told', async () => {
    await audit.record('login_failed', { email: 'a@example.com' });
    expect(SecurityEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'login_failed', outcome: 'failure' })
    );
  });

  it('records an authorization denial, including who and where', async () => {
    const Warehouse = require('../../src/models/Warehouse');
    // A viewer reaching for something only an editor may do.
    const shared = {
      _id: '507f1f77bcf86cd799439011',
      ownerId: USER_A_ID,
      collaborators: [{ userId: USER_B_ID, role: 'viewer' }],
      rows: 20,
      cols: 20,
      cells: [],
      dynamicObstacles: [],
    };
    shared.toObject = () => ({ ...shared, toObject: undefined });
    Warehouse.findOne.mockResolvedValue(shared);

    await asUser(request(app).post(`/api/warehouses/${shared._id}/tick`).send({}));

    expect(SecurityEvent.__events.some((e) => e.type === 'authorization_denied')).toBe(true);
  });
});

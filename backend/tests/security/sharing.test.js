/**
 * Warehouse sharing.
 *
 * Ownership used to be the whole of the authorization model - one user per
 * warehouse, no team, no viewer, no shared simulation - and the workaround
 * that forced was "send them your password". Sharing introduces a second
 * axis to every access decision, so what these tests are really checking
 * is that it did not introduce a third state where a warehouse is
 * *listable* but not readable, or reachable but at the wrong level.
 */
const request = require('supertest');

jest.mock('../../src/models/Warehouse', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findOneAndDelete: jest.fn(),
  create: jest.fn(),
  countDocuments: jest.fn(),
  deleteMany: jest.fn(),
  CELL_TYPES: ['shelf', 'charging', 'obstacle', 'dock'],
}));

jest.mock('../../src/models/User', () => ({
  findById: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  countDocuments: jest.fn(),
  EMAIL_PATTERN: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  ROLES: ['user', 'admin'],
}));

jest.mock('../../src/models/SecurityEvent', () => ({
  create: jest.fn().mockResolvedValue({}),
  TYPES: [],
}));

jest.mock('../../src/services/simulationManager', () => ({
  getEngine: jest.fn().mockResolvedValue(null),
  getOrderCoordinator: jest.fn().mockResolvedValue(null),
  invalidate: jest.fn(),
  persistRobot: jest.fn(),
  persistRobots: jest.fn(),
  persistObstacles: jest.fn().mockResolvedValue(undefined),
  readObstacles: jest.fn().mockResolvedValue([]),
  engines: new Map(),
  pinned: new Set(),
}));

const Warehouse = require('../../src/models/Warehouse');
const User = require('../../src/models/User');
const app = require('../../src/app');
const { mockQuery } = require('../helpers/mockQuery');
const { makeUser, tokenFor, USER_A_ID, USER_B_ID, WAREHOUSE_A_ID } = require('../helpers/auth');

const OWNER = makeUser(USER_A_ID);
const GUEST = makeUser(USER_B_ID, { email: 'guest@example.com' });

function asOwner(req) {
  return req.set('Authorization', `Bearer ${tokenFor(OWNER)}`);
}
function asGuest(req) {
  return req.set('Authorization', `Bearer ${tokenFor(GUEST)}`);
}

/** A warehouse owned by user A, optionally shared with user B. */
function warehouse(collaborators = []) {
  const doc = {
    _id: WAREHOUSE_A_ID,
    ownerId: USER_A_ID,
    name: 'Shared Warehouse',
    rows: 20,
    cols: 20,
    cells: [],
    collaborators,
    dynamicObstacles: [],
  };
  doc.toObject = () => ({ ...doc, toObject: undefined });
  return doc;
}

/** Wires the model the way the access filter actually queries it:
 * `{_id, $or: [{ownerId}, {'collaborators.userId'}]}`. */
function mockAccess(doc) {
  Warehouse.findOne.mockImplementation((filter = {}) => {
    if (filter._id && String(filter._id) !== String(doc._id)) return Promise.resolve(null);
    const asking = filter.ownerId ?? filter.$or?.[0]?.ownerId;
    if (asking === undefined) return Promise.resolve(doc);
    const isOwner = String(asking) === String(doc.ownerId);
    const shared =
      Boolean(filter.$or) && doc.collaborators.some((c) => String(c.userId) === String(asking));
    return Promise.resolve(isOwner || shared ? doc : null);
  });
  return doc;
}

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockImplementation((id) =>
    Promise.resolve(String(id) === USER_A_ID ? OWNER : String(id) === USER_B_ID ? GUEST : null)
  );
  Warehouse.find.mockReturnValue(mockQuery([]));
  Warehouse.countDocuments.mockResolvedValue(0);
});

describe('a warehouse shared with nobody', () => {
  it('is invisible to everyone but its owner', async () => {
    mockAccess(warehouse());
    const res = await asGuest(request(app).get(`/api/warehouses/${WAREHOUSE_A_ID}`));
    // 404, not 403: a 403 confirms the id exists, which is all an attacker
    // enumerating ObjectIds needs.
    expect(res.status).toBe(404);
  });
});

describe('a viewer', () => {
  const shared = () => mockAccess(warehouse([{ userId: USER_B_ID, role: 'viewer' }]));

  it('can read the warehouse', async () => {
    shared();
    const res = await asGuest(request(app).get(`/api/warehouses/${WAREHOUSE_A_ID}`));
    expect(res.status).toBe(200);
    // The response says how far they reach, so the client can render it
    // read-only rather than discovering that by collecting a 403.
    expect(res.body.data.access).toBe('view');
  });

  it('can read its obstacles', async () => {
    shared();
    const res = await asGuest(request(app).get(`/api/warehouses/${WAREHOUSE_A_ID}/obstacles`));
    expect(res.status).toBe(200);
  });

  it('cannot change what is in it', async () => {
    shared();
    const res = await asGuest(
      request(app)
        .post(`/api/warehouses/${WAREHOUSE_A_ID}/obstacles`)
        .send({ id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 1 }] })
    );
    // 403 here, not 404: they already know it exists, so there is nothing
    // left to conceal, and "you may look but not touch" is useful to hear.
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ required: 'edit', granted: 'view' });
  });

  it('cannot advance the simulation', async () => {
    shared();
    const res = await asGuest(request(app).post(`/api/warehouses/${WAREHOUSE_A_ID}/tick`).send({}));
    expect(res.status).toBe(403);
  });

  it('cannot delete it', async () => {
    shared();
    const res = await asGuest(request(app).delete(`/api/warehouses/${WAREHOUSE_A_ID}`));
    expect(res.status).toBe(403);
  });

  it('cannot share it onward', async () => {
    shared();
    const res = await asGuest(
      request(app)
        .post(`/api/warehouses/${WAREHOUSE_A_ID}/collaborators`)
        .send({ email: 'someone@example.com' })
    );
    expect(res.status).toBe(403);
  });
});

describe('an editor', () => {
  const shared = () => mockAccess(warehouse([{ userId: USER_B_ID, role: 'editor' }]));

  it('can change what is in the warehouse', async () => {
    shared();
    const res = await asGuest(request(app).post(`/api/warehouses/${WAREHOUSE_A_ID}/tick`).send({}));
    // 404 from the tick itself (no engine in this suite), which is the
    // point: it got past authorization.
    expect(res.status).not.toBe(403);
  });

  it('cannot reshape the warehouse', async () => {
    // Changing rows/cols/cells invalidates the live engine and requeues
    // every in-flight order. Reshaping the building is not something a
    // collaborator does to it.
    shared();
    const res = await asGuest(
      request(app).put(`/api/warehouses/${WAREHOUSE_A_ID}`).send({ rows: 30, cols: 30 })
    );
    expect(res.status).toBe(403);
  });

  it('cannot delete it', async () => {
    shared();
    const res = await asGuest(request(app).delete(`/api/warehouses/${WAREHOUSE_A_ID}`));
    expect(res.status).toBe(403);
  });

  it('cannot remove the owner, or anyone else', async () => {
    // Otherwise the first person you share with can remove you from your
    // own warehouse.
    shared();
    const res = await asGuest(
      request(app).delete(`/api/warehouses/${WAREHOUSE_A_ID}/collaborators/${USER_A_ID}`)
    );
    expect(res.status).toBe(403);
  });
});

describe('managing collaborators', () => {
  it('adds one by email', async () => {
    const doc = mockAccess(warehouse());
    User.findOne.mockReturnValue({
      select: () => Promise.resolve({ _id: USER_B_ID, email: 'guest@example.com', name: 'Guest' }),
    });
    Warehouse.findOneAndUpdate.mockResolvedValue({
      ...doc,
      collaborators: [{ userId: USER_B_ID, role: 'viewer' }],
    });

    const res = await asOwner(
      request(app)
        .post(`/api/warehouses/${WAREHOUSE_A_ID}/collaborators`)
        .send({ email: 'guest@example.com', role: 'viewer' })
    );

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ userId: USER_B_ID, role: 'viewer' });
  });

  it('refuses an address with no account in the same shape as one already added', async () => {
    // Anything that distinguished them would make this endpoint a way to
    // ask "does this person have an account here?".
    mockAccess(warehouse());
    User.findOne.mockReturnValue({ select: () => Promise.resolve(null) });

    const res = await asOwner(
      request(app)
        .post(`/api/warehouses/${WAREHOUSE_A_ID}/collaborators`)
        .send({ email: 'nobody@example.com' })
    );
    expect(res.status).toBe(422);
  });

  it('refuses to add the owner as their own collaborator', async () => {
    mockAccess(warehouse());
    User.findOne.mockReturnValue({
      select: () => Promise.resolve({ _id: USER_A_ID, email: 'owner@example.com' }),
    });

    const res = await asOwner(
      request(app)
        .post(`/api/warehouses/${WAREHOUSE_A_ID}/collaborators`)
        .send({ email: 'owner@example.com' })
    );
    expect(res.status).toBe(422);
  });

  it('rejects a role that is not viewer or editor', async () => {
    // There is deliberately no `owner` role to grant: no amount of sharing
    // can produce a warehouse with two people who can each remove the
    // other.
    mockAccess(warehouse());
    const res = await asOwner(
      request(app)
        .post(`/api/warehouses/${WAREHOUSE_A_ID}/collaborators`)
        .send({ email: 'guest@example.com', role: 'owner' })
    );
    expect(res.status).toBe(400);
  });

  it('lists them with the addresses the owner recognises', async () => {
    mockAccess(warehouse([{ userId: USER_B_ID, role: 'editor', addedAt: new Date() }]));
    User.find.mockReturnValue({
      select: () => Promise.resolve([{ _id: USER_B_ID, email: 'guest@example.com', name: 'Guest' }]),
    });

    const res = await asOwner(request(app).get(`/api/warehouses/${WAREHOUSE_A_ID}/collaborators`));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({ userId: USER_B_ID, email: 'guest@example.com', role: 'editor' }),
    ]);
  });

  it('removes one', async () => {
    const doc = mockAccess(warehouse([{ userId: USER_B_ID, role: 'viewer' }]));
    Warehouse.findOneAndUpdate.mockResolvedValue({ ...doc, collaborators: [] });

    const res = await asOwner(
      request(app).delete(`/api/warehouses/${WAREHOUSE_A_ID}/collaborators/${USER_B_ID}`)
    );
    expect(res.status).toBe(204);
  });
});

describe('listing', () => {
  it('is scoped to warehouses the caller can reach, owned or shared', async () => {
    await asGuest(request(app).get('/api/warehouses'));
    expect(Warehouse.find).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [{ ownerId: USER_B_ID }, { 'collaborators.userId': USER_B_ID }],
      })
    );
  });
});

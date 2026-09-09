const request = require('supertest');
const { mockQuery } = require('./helpers/mockQuery');
const { authed, mockOwnership, makeWarehouse, USER_A_ID, WAREHOUSE_A_ID } = require('./helpers/auth');

const VALID_ID = WAREHOUSE_A_ID;

jest.mock('../src/models/Warehouse', () => {
  const mockModel = {
    find: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findByIdAndDelete: jest.fn(),
    findOneAndDelete: jest.fn(),
    countDocuments: jest.fn(),
    activate: jest.fn(),
  };
  mockModel.CELL_TYPES = ['shelf', 'charging', 'obstacle', 'dock'];
  return mockModel;
});

// Deleting a warehouse now cascades to its dependent collections - see
// the doc comment on `remove` in controllers/warehouse.controller.js.
jest.mock('../src/models/Robot', () => ({ deleteMany: jest.fn(), STATUSES: ['idle', 'moving', 'charging', 'error'] }));
jest.mock('../src/models/Order', () => ({ deleteMany: jest.fn(), STATUSES: [], PRIORITIES: [] }));
jest.mock('../src/models/Statistics', () => ({ deleteMany: jest.fn() }));
jest.mock('../src/models/Log', () => ({ deleteMany: jest.fn(), LEVELS: ['info', 'warn', 'error'] }));

const Warehouse = require('../src/models/Warehouse');
const Robot = require('../src/models/Robot');
const Order = require('../src/models/Order');
const Statistics = require('../src/models/Statistics');
const Log = require('../src/models/Log');
const app = require('../src/app');

beforeEach(() => {
  jest.clearAllMocks();
  for (const model of [Robot, Order, Statistics, Log]) {
    model.deleteMany.mockResolvedValue({ deletedCount: 0 });
  }
  // The ownership middleware resolves every :id through findOne({_id, ownerId}).
  mockOwnership(Warehouse);
});

describe('GET /api/warehouses', () => {
  it('lists warehouses', async () => {
    Warehouse.find.mockReturnValue(mockQuery([{ _id: VALID_ID, name: 'Main Floor' }]));
    Warehouse.countDocuments.mockResolvedValue(1);

    const res = await authed(request(app).get('/api/warehouses'));
    expect(res.status).toBe(200);
    expect(res.body.data[0].name).toBe('Main Floor');
  });

  it('scopes the query to the calling user', async () => {
    Warehouse.find.mockReturnValue(mockQuery([]));
    Warehouse.countDocuments.mockResolvedValue(0);

    await authed(request(app).get('/api/warehouses'));

    expect(Warehouse.find).toHaveBeenCalledWith(expect.objectContaining({ ownerId: USER_A_ID }));
  });
});

describe('POST /api/warehouses', () => {
  it('creates a warehouse from a serialized grid payload', async () => {
    const payload = {
      name: 'Main Floor',
      rows: 20,
      cols: 30,
      cells: [{ x: 1, y: 2, type: 'shelf' }],
    };
    Warehouse.create.mockResolvedValue({ _id: VALID_ID, ...payload });

    const res = await authed(request(app).post('/api/warehouses').send(payload));

    expect(res.status).toBe(201);
    expect(Warehouse.create).toHaveBeenCalledWith(
      expect.objectContaining({ ...payload, ownerId: USER_A_ID })
    );
  });

  it('rejects rows below the minimum grid size', async () => {
    const res = await authed(request(app).post('/api/warehouses').send({ name: 'Tiny', rows: 1, cols: 10 }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.some((d) => d.field === 'rows')).toBe(true);
  });
});

describe('PATCH /api/warehouses/:id/activate', () => {
  it('activates a warehouse', async () => {
    Warehouse.activate.mockResolvedValue({ _id: VALID_ID, isActive: true });
    const res = await authed(request(app).patch(`/api/warehouses/${VALID_ID}/activate`));
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(true);
    // Scoped by owner: activating one warehouse must not deactivate another
    // user's.
    expect(Warehouse.activate).toHaveBeenCalledWith(VALID_ID, USER_A_ID);
  });

  it('returns 404 activating a warehouse that does not exist', async () => {
    Warehouse.findOne.mockResolvedValue(null);
    const res = await authed(request(app).patch(`/api/warehouses/${VALID_ID}/activate`));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/warehouses/:id', () => {
  it('deletes a warehouse and returns 204', async () => {
    Warehouse.findOneAndDelete.mockResolvedValue({ _id: VALID_ID });
    const res = await authed(request(app).delete(`/api/warehouses/${VALID_ID}`));
    expect(res.status).toBe(204);
  });

  it('cascades to every collection that hangs off the warehouse', async () => {
    // These documents are only reachable *through* their warehouse (see
    // middleware/authorize.js), so leaving them behind makes them
    // permanently invisible and permanently undeletable.
    Warehouse.findOneAndDelete.mockResolvedValue({ _id: VALID_ID });

    const res = await authed(request(app).delete(`/api/warehouses/${VALID_ID}`));

    expect(res.status).toBe(204);
    for (const model of [Robot, Order, Statistics, Log]) {
      expect(model.deleteMany).toHaveBeenCalledWith({ warehouseId: VALID_ID });
    }
  });

  it('deletes the children before the parent, so a partial failure is retryable', async () => {
    // No transactions here (they need a replica set), so the ordering is
    // the guarantee: if this dies half-way, the warehouse still exists and
    // repeating the request finishes the job.
    const calls = [];
    Robot.deleteMany.mockImplementation(async () => {
      calls.push('children');
      return { deletedCount: 0 };
    });
    Warehouse.findOneAndDelete.mockImplementation(async () => {
      calls.push('warehouse');
      return { _id: VALID_ID };
    });

    await authed(request(app).delete(`/api/warehouses/${VALID_ID}`));

    expect(calls).toEqual(['children', 'warehouse']);
  });
});

describe('POST /api/warehouses/:id/path', () => {
  const layoutWithWall = makeWarehouse(VALID_ID, USER_A_ID, {
    rows: 6,
    cols: 6,
    cells: [
      { x: 3, y: 0, type: 'shelf' },
      { x: 3, y: 1, type: 'shelf' },
      { x: 3, y: 2, type: 'shelf' },
      { x: 3, y: 3, type: 'shelf' },
      { x: 3, y: 4, type: 'shelf' },
      // gap at (3,5)
    ],
  });

  it('runs the real A* engine against the warehouse layout and returns a path', async () => {
    mockOwnership(Warehouse, { warehouse: layoutWithWall });

    const res = await authed(
      request(app)
        .post(`/api/warehouses/${VALID_ID}/path`)
        .send({ start: { x: 0, y: 0 }, goal: { x: 5, y: 0 } })
    );

    expect(res.status).toBe(200);
    expect(res.body.data.found).toBe(true);
    expect(res.body.data.path.some((p) => p.x === 3 && p.y === 5)).toBe(true);
  });

  it('returns 404 when the warehouse does not exist', async () => {
    Warehouse.findOne.mockResolvedValue(null);
    const res = await authed(
      request(app)
        .post(`/api/warehouses/${VALID_ID}/path`)
        .send({ start: { x: 0, y: 0 }, goal: { x: 1, y: 1 } })
    );
    expect(res.status).toBe(404);
  });

  it('rejects a request missing goal coordinates', async () => {
    const res = await authed(
      request(app).post(`/api/warehouses/${VALID_ID}/path`).send({ start: { x: 0, y: 0 } })
    );
    expect(res.status).toBe(400);
    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['goal.x', 'goal.y']));
  });

  it('rejects an unknown heuristic name', async () => {
    const res = await authed(
      request(app)
        .post(`/api/warehouses/${VALID_ID}/path`)
        .send({ start: { x: 0, y: 0 }, goal: { x: 1, y: 1 }, heuristic: 'bogus' })
    );
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean trace value', async () => {
    const res = await authed(
      request(app)
        .post(`/api/warehouses/${VALID_ID}/path`)
        .send({ start: { x: 0, y: 0 }, goal: { x: 1, y: 1 }, trace: 'yes' })
    );
    expect(res.status).toBe(400);
  });

  it('with trace:true, returns a step-by-step recording alongside the normal result', async () => {
    mockOwnership(Warehouse, {
      warehouse: makeWarehouse(VALID_ID, USER_A_ID, { rows: 6, cols: 6, cells: [] }),
    });

    const res = await authed(
      request(app)
        .post(`/api/warehouses/${VALID_ID}/path`)
        .send({ start: { x: 0, y: 0 }, goal: { x: 4, y: 4 }, trace: true })
    );

    expect(res.status).toBe(200);
    expect(res.body.data.found).toBe(true);
    expect(Array.isArray(res.body.data.steps)).toBe(true);
    expect(res.body.data.steps.length).toBeGreaterThan(0);
    expect(res.body.data).toHaveProperty('stepsTruncated', false);
    const lastStep = res.body.data.steps[res.body.data.steps.length - 1];
    expect(Array.isArray(lastStep.openSet)).toBe(true);
  });

  it('without trace (the default), the response has no steps array', async () => {
    mockOwnership(Warehouse, {
      warehouse: makeWarehouse(VALID_ID, USER_A_ID, { rows: 6, cols: 6, cells: [] }),
    });

    const res = await authed(
      request(app)
        .post(`/api/warehouses/${VALID_ID}/path`)
        .send({ start: { x: 0, y: 0 }, goal: { x: 4, y: 4 } })
    );

    expect(res.status).toBe(200);
    expect(res.body.data.steps).toBeUndefined();
  });
});

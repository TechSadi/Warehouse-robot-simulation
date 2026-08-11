const request = require('supertest');
const { mockQuery } = require('./helpers/mockQuery');

const VALID_ID = '507f1f77bcf86cd799439011';

jest.mock('../src/models/Warehouse', () => {
  const mockModel = {
    find: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findByIdAndDelete: jest.fn(),
    countDocuments: jest.fn(),
    activate: jest.fn(),
  };
  mockModel.CELL_TYPES = ['shelf', 'charging', 'obstacle', 'dock'];
  return mockModel;
});

const Warehouse = require('../src/models/Warehouse');
const app = require('../src/app');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/warehouses', () => {
  it('lists warehouses', async () => {
    Warehouse.find.mockReturnValue(mockQuery([{ _id: VALID_ID, name: 'Main Floor' }]));
    Warehouse.countDocuments.mockResolvedValue(1);

    const res = await request(app).get('/api/warehouses');
    expect(res.status).toBe(200);
    expect(res.body.data[0].name).toBe('Main Floor');
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

    const res = await request(app).post('/api/warehouses').send(payload);

    expect(res.status).toBe(201);
    expect(Warehouse.create).toHaveBeenCalledWith(expect.objectContaining(payload));
  });

  it('rejects rows below the minimum grid size', async () => {
    const res = await request(app).post('/api/warehouses').send({ name: 'Tiny', rows: 1, cols: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error.details.some((d) => d.field === 'rows')).toBe(true);
  });
});

describe('PATCH /api/warehouses/:id/activate', () => {
  it('activates a warehouse', async () => {
    Warehouse.activate.mockResolvedValue({ _id: VALID_ID, isActive: true });
    const res = await request(app).patch(`/api/warehouses/${VALID_ID}/activate`);
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(true);
    expect(Warehouse.activate).toHaveBeenCalledWith(VALID_ID);
  });

  it('returns 404 activating a warehouse that does not exist', async () => {
    Warehouse.activate.mockResolvedValue(null);
    const res = await request(app).patch(`/api/warehouses/${VALID_ID}/activate`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/warehouses/:id', () => {
  it('deletes a warehouse and returns 204', async () => {
    Warehouse.findByIdAndDelete.mockResolvedValue({ _id: VALID_ID });
    const res = await request(app).delete(`/api/warehouses/${VALID_ID}`);
    expect(res.status).toBe(204);
  });
});

describe('POST /api/warehouses/:id/path', () => {
  it('runs the real A* engine against the warehouse layout and returns a path', async () => {
    Warehouse.findById.mockResolvedValue({
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

    const res = await request(app)
      .post(`/api/warehouses/${VALID_ID}/path`)
      .send({ start: { x: 0, y: 0 }, goal: { x: 5, y: 0 } });

    expect(res.status).toBe(200);
    expect(res.body.data.found).toBe(true);
    expect(res.body.data.path.some((p) => p.x === 3 && p.y === 5)).toBe(true);
  });

  it('returns 404 when the warehouse does not exist', async () => {
    Warehouse.findById.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/warehouses/${VALID_ID}/path`)
      .send({ start: { x: 0, y: 0 }, goal: { x: 1, y: 1 } });
    expect(res.status).toBe(404);
  });

  it('rejects a request missing goal coordinates', async () => {
    const res = await request(app)
      .post(`/api/warehouses/${VALID_ID}/path`)
      .send({ start: { x: 0, y: 0 } });
    expect(res.status).toBe(400);
    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['goal.x', 'goal.y']));
  });

  it('rejects an unknown heuristic name', async () => {
    const res = await request(app)
      .post(`/api/warehouses/${VALID_ID}/path`)
      .send({ start: { x: 0, y: 0 }, goal: { x: 1, y: 1 }, heuristic: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean trace value', async () => {
    const res = await request(app)
      .post(`/api/warehouses/${VALID_ID}/path`)
      .send({ start: { x: 0, y: 0 }, goal: { x: 1, y: 1 }, trace: 'yes' });
    expect(res.status).toBe(400);
  });

  it('with trace:true, returns a step-by-step recording alongside the normal result', async () => {
    Warehouse.findById.mockResolvedValue({ rows: 6, cols: 6, cells: [] });

    const res = await request(app)
      .post(`/api/warehouses/${VALID_ID}/path`)
      .send({ start: { x: 0, y: 0 }, goal: { x: 4, y: 4 }, trace: true });

    expect(res.status).toBe(200);
    expect(res.body.data.found).toBe(true);
    expect(Array.isArray(res.body.data.steps)).toBe(true);
    expect(res.body.data.steps.length).toBeGreaterThan(0);
    expect(res.body.data).toHaveProperty('stepsTruncated', false);
    const lastStep = res.body.data.steps[res.body.data.steps.length - 1];
    expect(Array.isArray(lastStep.openSet)).toBe(true);
  });

  it('without trace (the default), the response has no steps array', async () => {
    Warehouse.findById.mockResolvedValue({ rows: 6, cols: 6, cells: [] });

    const res = await request(app)
      .post(`/api/warehouses/${VALID_ID}/path`)
      .send({ start: { x: 0, y: 0 }, goal: { x: 4, y: 4 } });

    expect(res.status).toBe(200);
    expect(res.body.data.steps).toBeUndefined();
  });
});

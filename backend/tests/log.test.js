const request = require('supertest');
const { mockQuery } = require('./helpers/mockQuery');
const { authed, mockOwnership, makeWarehouse, USER_A_ID } = require('./helpers/auth');

const VALID_ID = '507f1f77bcf86cd799439011';
const WAREHOUSE_ID = '507f1f77bcf86cd799439022';

jest.mock('../src/models/Log', () => {
  const mockModel = {
    find: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    findByIdAndDelete: jest.fn(),
    countDocuments: jest.fn(),
  };
  mockModel.LEVELS = ['info', 'warn', 'error'];
  return mockModel;
});

jest.mock('../src/models/Warehouse', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
  CELL_TYPES: ['shelf', 'charging', 'obstacle', 'dock'],
}));

const Log = require('../src/models/Log');
const Warehouse = require('../src/models/Warehouse');
const app = require('../src/app');

beforeEach(() => {
  jest.clearAllMocks();
  mockOwnership(Warehouse, { warehouse: makeWarehouse(WAREHOUSE_ID, USER_A_ID) });
  Warehouse.find.mockReturnValue(mockQuery([{ _id: WAREHOUSE_ID }]));
  Log.findById.mockResolvedValue({ _id: VALID_ID, warehouseId: WAREHOUSE_ID });
});

describe('POST /api/logs', () => {
  it('creates a log entry attributed to the client', async () => {
    Log.create.mockResolvedValue({ _id: VALID_ID, level: 'warn', message: 'Robot R1 battery low' });

    const res = await authed(
      request(app)
        .post('/api/logs')
        .send({ level: 'warn', message: 'Robot R1 battery low', warehouseId: WAREHOUSE_ID })
    );

    expect(res.status).toBe(201);
    expect(res.body.data.level).toBe('warn');
    // `source` is pinned server-side so client-written entries cannot
    // masquerade as the engine's own audit trail.
    expect(Log.create).toHaveBeenCalledWith(expect.objectContaining({ source: 'client' }));
  });

  it('refuses a client-chosen source', async () => {
    const res = await authed(
      request(app)
        .post('/api/logs')
        .send({ message: 'looks official', warehouseId: WAREHOUSE_ID, source: 'robot-engine' })
    );
    expect(res.status).toBe(422);
    expect(Log.create).not.toHaveBeenCalled();
  });

  it('rejects an empty message', async () => {
    const res = await authed(request(app).post('/api/logs').send({ message: '', warehouseId: WAREHOUSE_ID }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/logs', () => {
  it("filters by level and source within the caller's warehouses", async () => {
    Log.find.mockReturnValue(mockQuery([]));
    Log.countDocuments.mockResolvedValue(0);

    await authed(request(app).get(`/api/logs?warehouseId=${WAREHOUSE_ID}&level=error&source=scheduler`));

    expect(Log.find).toHaveBeenCalledWith({
      warehouseId: WAREHOUSE_ID,
      level: 'error',
      source: 'scheduler',
    });
  });
});

describe('append-only design', () => {
  it('has no update endpoint for log entries', async () => {
    const res = await authed(request(app).put(`/api/logs/${VALID_ID}`).send({}));
    expect(res.status).toBe(404);
  });
});

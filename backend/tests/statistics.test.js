const request = require('supertest');
const { mockQuery } = require('./helpers/mockQuery');

const VALID_ID = '507f1f77bcf86cd799439011';
const WAREHOUSE_ID = '507f1f77bcf86cd799439022';

jest.mock('../src/models/Statistics', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  findByIdAndDelete: jest.fn(),
  countDocuments: jest.fn(),
}));

const Statistics = require('../src/models/Statistics');
const app = require('../src/app');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/statistics', () => {
  it('creates a snapshot', async () => {
    const payload = { warehouseId: WAREHOUSE_ID, metrics: { activeRobots: 3, avgBattery: 72 } };
    Statistics.create.mockResolvedValue({ _id: VALID_ID, ...payload });

    const res = await request(app).post('/api/statistics').send(payload);
    expect(res.status).toBe(201);
    expect(res.body.data.metrics.activeRobots).toBe(3);
  });

  it('rejects an avgBattery over 100', async () => {
    const res = await request(app)
      .post('/api/statistics')
      .send({ warehouseId: WAREHOUSE_ID, metrics: { avgBattery: 150 } });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/statistics', () => {
  it('filters by date range', async () => {
    Statistics.find.mockReturnValue(mockQuery([]));
    Statistics.countDocuments.mockResolvedValue(0);

    const res = await request(app).get('/api/statistics?from=2026-01-01&to=2026-01-31');
    expect(res.status).toBe(200);
    const filterArg = Statistics.find.mock.calls[0][0];
    expect(filterArg.recordedAt.$gte).toBeInstanceOf(Date);
    expect(filterArg.recordedAt.$lte).toBeInstanceOf(Date);
  });
});

describe('append-only design', () => {
  it('has no update endpoint for statistics snapshots', async () => {
    const res = await request(app).put(`/api/statistics/${VALID_ID}`).send({});
    expect(res.status).toBe(404);
  });
});

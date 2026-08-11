const request = require('supertest');
const { mockQuery } = require('./helpers/mockQuery');

const VALID_ID = '507f1f77bcf86cd799439011';

jest.mock('../src/models/Log', () => {
  const mockModel = {
    find: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    findByIdAndDelete: jest.fn(),
    countDocuments: jest.fn(),
  };
  mockModel.LEVELS = ['info', 'warn', 'error'];
  return mockModel;
});

const Log = require('../src/models/Log');
const app = require('../src/app');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/logs', () => {
  it('creates a log entry', async () => {
    Log.create.mockResolvedValue({ _id: VALID_ID, level: 'warn', message: 'Robot R1 battery low' });

    const res = await request(app)
      .post('/api/logs')
      .send({ level: 'warn', message: 'Robot R1 battery low', source: 'robot-engine' });

    expect(res.status).toBe(201);
    expect(res.body.data.level).toBe('warn');
  });

  it('rejects an empty message', async () => {
    const res = await request(app).post('/api/logs').send({ message: '' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/logs', () => {
  it('filters by level and source', async () => {
    Log.find.mockReturnValue(mockQuery([]));
    Log.countDocuments.mockResolvedValue(0);

    await request(app).get('/api/logs?level=error&source=scheduler');

    expect(Log.find).toHaveBeenCalledWith({ level: 'error', source: 'scheduler' });
  });
});

describe('append-only design', () => {
  it('has no update endpoint for log entries', async () => {
    const res = await request(app).put(`/api/logs/${VALID_ID}`).send({});
    expect(res.status).toBe(404);
  });
});

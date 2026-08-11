const request = require('supertest');

const VALID_ID = '507f1f77bcf86cd799439011';
const WAREHOUSE_ID = '507f1f77bcf86cd799439022';

jest.mock('../../src/models/Robot', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findByIdAndDelete: jest.fn(),
  countDocuments: jest.fn(),
  STATUSES: ['idle', 'moving', 'charging', 'error'],
}));

jest.mock('../../src/services/simulationManager', () => ({
  getEngine: jest.fn(),
  getOrderCoordinator: jest.fn(),
  persistRobot: jest.fn(),
  invalidate: jest.fn(),
}));

const Robot = require('../../src/models/Robot');
const simulationManager = require('../../src/services/simulationManager');
const app = require('../../src/app');

function fakeEngine(overrides = {}) {
  return {
    getRobot: jest.fn().mockReturnValue({ id: VALID_ID }),
    addObstacle: jest.fn(),
    removeObstacle: jest.fn(),
    getObstacles: jest.fn().mockReturnValue([]),
    markBroken: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  simulationManager.persistRobot.mockResolvedValue();
});

describe('GET /api/warehouses/:id/obstacles', () => {
  it('lists active obstacles', () => {
    const obstacles = [{ id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 1 }] }];
    simulationManager.getEngine.mockResolvedValue(fakeEngine({ getObstacles: jest.fn().mockReturnValue(obstacles) }));

    return request(app)
      .get(`/api/warehouses/${WAREHOUSE_ID}/obstacles`)
      .then((res) => {
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual(obstacles);
      });
  });

  it('returns 404 when the warehouse does not exist', async () => {
    simulationManager.getEngine.mockResolvedValue(null);
    const res = await request(app).get(`/api/warehouses/${WAREHOUSE_ID}/obstacles`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/warehouses/:id/obstacles', () => {
  it('adds an obstacle', async () => {
    const snapshot = { id: 'zone1', type: 'construction_zone', cells: [{ x: 3, y: 3 }] };
    const engine = fakeEngine({ addObstacle: jest.fn().mockReturnValue(snapshot) });
    simulationManager.getEngine.mockResolvedValue(engine);

    const res = await request(app)
      .post(`/api/warehouses/${WAREHOUSE_ID}/obstacles`)
      .send({ id: 'zone1', type: 'construction_zone', cells: [{ x: 3, y: 3 }] });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(snapshot);
    expect(engine.addObstacle).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'zone1', type: 'construction_zone' })
    );
  });

  it('rejects an invalid obstacle type', async () => {
    const res = await request(app)
      .post(`/api/warehouses/${WAREHOUSE_ID}/obstacles`)
      .send({ id: 'o1', type: 'bogus', cells: [{ x: 0, y: 0 }] });
    expect(res.status).toBe(400);
  });

  it('rejects a missing/empty cells array', async () => {
    const res = await request(app)
      .post(`/api/warehouses/${WAREHOUSE_ID}/obstacles`)
      .send({ id: 'o1', type: 'human_worker', cells: [] });
    expect(res.status).toBe(400);
  });

  it('rejects a missing id', async () => {
    const res = await request(app)
      .post(`/api/warehouses/${WAREHOUSE_ID}/obstacles`)
      .send({ type: 'human_worker', cells: [{ x: 0, y: 0 }] });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/warehouses/:id/obstacles/:obstacleId', () => {
  it('removes an obstacle', async () => {
    const engine = fakeEngine({ removeObstacle: jest.fn().mockReturnValue(true) });
    simulationManager.getEngine.mockResolvedValue(engine);

    const res = await request(app).delete(`/api/warehouses/${WAREHOUSE_ID}/obstacles/zone1`);
    expect(res.status).toBe(204);
    expect(engine.removeObstacle).toHaveBeenCalledWith('zone1');
  });

  it('returns 404 when the obstacle does not exist', async () => {
    const engine = fakeEngine({ removeObstacle: jest.fn().mockReturnValue(false) });
    simulationManager.getEngine.mockResolvedValue(engine);

    const res = await request(app).delete(`/api/warehouses/${WAREHOUSE_ID}/obstacles/ghost`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/robots/:id/break', () => {
  it('marks a robot as broken and persists the result', async () => {
    Robot.findById.mockResolvedValue({ _id: VALID_ID, warehouseId: WAREHOUSE_ID });
    const snapshot = { id: VALID_ID, status: 'error', errorReason: 'Wheel motor failure' };
    const engine = fakeEngine({ markBroken: jest.fn().mockReturnValue(snapshot) });
    simulationManager.getEngine.mockResolvedValue(engine);

    const res = await request(app)
      .post(`/api/robots/${VALID_ID}/break`)
      .send({ reason: 'Wheel motor failure' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('error');
    expect(engine.markBroken).toHaveBeenCalledWith(VALID_ID, 'Wheel motor failure');
    expect(simulationManager.persistRobot).toHaveBeenCalledWith(VALID_ID, snapshot);
  });

  it('returns 404 when the robot does not exist', async () => {
    Robot.findById.mockResolvedValue(null);
    const res = await request(app).post(`/api/robots/${VALID_ID}/break`).send({});
    expect(res.status).toBe(404);
  });
});

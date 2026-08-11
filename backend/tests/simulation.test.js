const request = require('supertest');
const RobotEngineError = require('../src/engine/robots/robotEngineError');

const VALID_ID = '507f1f77bcf86cd799439011';
const WAREHOUSE_ID = '507f1f77bcf86cd799439022';

jest.mock('../src/models/Robot', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findByIdAndDelete: jest.fn(),
  countDocuments: jest.fn(),
  STATUSES: ['idle', 'moving', 'charging', 'error'],
}));

jest.mock('../src/services/simulationManager', () => ({
  getEngine: jest.fn(),
  getOrderCoordinator: jest.fn(),
  persistRobot: jest.fn(),
  persistRobots: jest.fn(),
  invalidate: jest.fn(),
}));

jest.mock('../src/services/orderService', () => ({
  generateOrders: jest.fn(),
  dispatchPendingOrders: jest.fn(),
  processTickEvents: jest.fn(),
}));

jest.mock('../src/models/Log', () => ({
  create: jest.fn(),
  LEVELS: ['info', 'warn', 'error'],
}));

const Robot = require('../src/models/Robot');
const Log = require('../src/models/Log');
const simulationManager = require('../src/services/simulationManager');
const orderService = require('../src/services/orderService');
const app = require('../src/app');

function fakeEngine(overrides = {}) {
  return {
    getRobot: jest.fn().mockReturnValue({ id: VALID_ID }),
    assignTask: jest.fn(),
    startCharging: jest.fn(),
    clearError: jest.fn(),
    tick: jest.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  simulationManager.persistRobot.mockResolvedValue();
  simulationManager.persistRobots.mockResolvedValue();
  orderService.processTickEvents.mockResolvedValue();
  orderService.dispatchPendingOrders.mockResolvedValue([]);
});

function fakeCoordinator(overrides = {}) {
  return { processTick: jest.fn().mockReturnValue([]), ...overrides };
}

describe('POST /api/robots/:id/tasks', () => {
  it('assigns a task and returns the updated snapshot', async () => {
    Robot.findById.mockResolvedValue({ _id: VALID_ID, warehouseId: WAREHOUSE_ID });
    const snapshot = { id: VALID_ID, status: 'moving' };
    const engine = fakeEngine({ assignTask: jest.fn().mockReturnValue(snapshot) });
    simulationManager.getEngine.mockResolvedValue(engine);

    const res = await request(app)
      .post(`/api/robots/${VALID_ID}/tasks`)
      .send({ destination: { x: 3, y: 4 } });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(snapshot);
    expect(engine.assignTask).toHaveBeenCalledWith(VALID_ID, { x: 3, y: 4 });
    expect(simulationManager.persistRobot).toHaveBeenCalledWith(VALID_ID, snapshot);
  });

  it('returns 404 when the robot does not exist', async () => {
    Robot.findById.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/robots/${VALID_ID}/tasks`)
      .send({ destination: { x: 1, y: 1 } });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the robot's warehouse no longer exists", async () => {
    Robot.findById.mockResolvedValue({ _id: VALID_ID, warehouseId: WAREHOUSE_ID });
    simulationManager.getEngine.mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/robots/${VALID_ID}/tasks`)
      .send({ destination: { x: 1, y: 1 } });
    expect(res.status).toBe(404);
  });

  it('returns 409 when the robot is not loaded in the live simulation', async () => {
    Robot.findById.mockResolvedValue({ _id: VALID_ID, warehouseId: WAREHOUSE_ID });
    const engine = fakeEngine({ getRobot: jest.fn().mockReturnValue(null) });
    simulationManager.getEngine.mockResolvedValue(engine);
    const res = await request(app)
      .post(`/api/robots/${VALID_ID}/tasks`)
      .send({ destination: { x: 1, y: 1 } });
    expect(res.status).toBe(409);
  });

  it('maps an UNWALKABLE_POSITION engine error to 400', async () => {
    Robot.findById.mockResolvedValue({ _id: VALID_ID, warehouseId: WAREHOUSE_ID });
    const engine = fakeEngine({
      assignTask: jest.fn().mockImplementation(() => {
        throw new RobotEngineError('UNWALKABLE_POSITION', 'Destination is not walkable');
      }),
    });
    simulationManager.getEngine.mockResolvedValue(engine);

    const res = await request(app)
      .post(`/api/robots/${VALID_ID}/tasks`)
      .send({ destination: { x: 1, y: 1 } });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not walkable/);
  });

  it('rejects a request missing destination coordinates', async () => {
    const res = await request(app).post(`/api/robots/${VALID_ID}/tasks`).send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/robots/:id/charge', () => {
  it('starts charging and persists the result', async () => {
    Robot.findById.mockResolvedValue({ _id: VALID_ID, warehouseId: WAREHOUSE_ID });
    const snapshot = { id: VALID_ID, status: 'charging' };
    const engine = fakeEngine({ startCharging: jest.fn().mockReturnValue(snapshot) });
    simulationManager.getEngine.mockResolvedValue(engine);

    const res = await request(app).post(`/api/robots/${VALID_ID}/charge`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('charging');
  });

  it('maps an INVALID_TRANSITION engine error to 409', async () => {
    Robot.findById.mockResolvedValue({ _id: VALID_ID, warehouseId: WAREHOUSE_ID });
    const engine = fakeEngine({
      startCharging: jest.fn().mockImplementation(() => {
        throw new RobotEngineError('INVALID_TRANSITION', 'Cannot start charging while moving');
      }),
    });
    simulationManager.getEngine.mockResolvedValue(engine);

    const res = await request(app).post(`/api/robots/${VALID_ID}/charge`);
    expect(res.status).toBe(409);
  });

  it('maps a NOT_AT_CHARGING_STATION engine error to 409', async () => {
    Robot.findById.mockResolvedValue({ _id: VALID_ID, warehouseId: WAREHOUSE_ID });
    const engine = fakeEngine({
      startCharging: jest.fn().mockImplementation(() => {
        throw new RobotEngineError('NOT_AT_CHARGING_STATION', 'Robot must be on a charging cell to charge');
      }),
    });
    simulationManager.getEngine.mockResolvedValue(engine);

    const res = await request(app).post(`/api/robots/${VALID_ID}/charge`);
    expect(res.status).toBe(409);
  });
});

describe('POST /api/robots/:id/clear-error', () => {
  it('clears the error and returns the updated snapshot', async () => {
    Robot.findById.mockResolvedValue({ _id: VALID_ID, warehouseId: WAREHOUSE_ID });
    const snapshot = { id: VALID_ID, status: 'idle', errorReason: null };
    const engine = fakeEngine({ clearError: jest.fn().mockReturnValue(snapshot) });
    simulationManager.getEngine.mockResolvedValue(engine);

    const res = await request(app).post(`/api/robots/${VALID_ID}/clear-error`);
    expect(res.status).toBe(200);
    expect(res.body.data.errorReason).toBeNull();
  });
});

describe('POST /api/warehouses/:id/tick', () => {
  it('advances the simulation, persists changed robots, processes order events, and dispatches pending orders', async () => {
    const changed = [
      { id: 'r1', status: 'moving' },
      { id: 'r2', status: 'idle' },
    ];
    const engine = fakeEngine({ tick: jest.fn().mockReturnValue(changed) });
    const orderEvents = [{ type: 'delivered', robotId: 'r2', orderId: 'o1' }];
    const coordinator = fakeCoordinator({ processTick: jest.fn().mockReturnValue(orderEvents) });
    simulationManager.getEngine.mockResolvedValue(engine);
    simulationManager.getOrderCoordinator.mockResolvedValue(coordinator);
    orderService.dispatchPendingOrders.mockResolvedValue([{ orderId: 'o2', robotId: 'r2' }]);

    const res = await request(app).post(`/api/warehouses/${WAREHOUSE_ID}/tick`).send({ deltaSeconds: 0.5 });

    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
    expect(engine.tick).toHaveBeenCalledWith(0.5);
    expect(coordinator.processTick).toHaveBeenCalledWith(changed);
    expect(orderService.processTickEvents).toHaveBeenCalledWith(WAREHOUSE_ID, orderEvents);
    expect(orderService.dispatchPendingOrders).toHaveBeenCalledWith(WAREHOUSE_ID);
    expect(res.body.data.orderEvents).toEqual(orderEvents);
    expect(res.body.data.dispatched).toEqual([{ orderId: 'o2', robotId: 'r2' }]);
    expect(simulationManager.persistRobots).toHaveBeenCalledWith(changed);
  });

  it('logs a warning for every robot that entered the error state this tick', async () => {
    const changed = [
      { id: 'r1', status: 'error', errorReason: 'Battery depleted' },
      { id: 'r2', status: 'idle' },
    ];
    const engine = fakeEngine({ tick: jest.fn().mockReturnValue(changed) });
    simulationManager.getEngine.mockResolvedValue(engine);
    simulationManager.getOrderCoordinator.mockResolvedValue(fakeCoordinator());

    await request(app).post(`/api/warehouses/${WAREHOUSE_ID}/tick`).send({});

    expect(Log.create).toHaveBeenCalledTimes(1);
    expect(Log.create).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'robot-engine', message: expect.stringMatching(/r1.*Battery depleted/) })
    );
  });

  it('defaults deltaSeconds to 1 when not provided', async () => {
    const engine = fakeEngine({ tick: jest.fn().mockReturnValue([]) });
    simulationManager.getEngine.mockResolvedValue(engine);
    simulationManager.getOrderCoordinator.mockResolvedValue(fakeCoordinator());

    await request(app).post(`/api/warehouses/${WAREHOUSE_ID}/tick`).send({});
    expect(engine.tick).toHaveBeenCalledWith(1);
  });

  it('returns 404 when the warehouse does not exist', async () => {
    simulationManager.getEngine.mockResolvedValue(null);
    simulationManager.getOrderCoordinator.mockResolvedValue(null);
    const res = await request(app).post(`/api/warehouses/${WAREHOUSE_ID}/tick`).send({});
    expect(res.status).toBe(404);
  });

  it('rejects a deltaSeconds outside the allowed range', async () => {
    const res = await request(app).post(`/api/warehouses/${WAREHOUSE_ID}/tick`).send({ deltaSeconds: 20 });
    expect(res.status).toBe(400);
  });
});

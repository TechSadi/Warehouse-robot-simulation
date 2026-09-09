/**
 * Resource-level authorization: IDOR / BOLA across every resource type.
 *
 * The shape of every case here is the same. Two users, each owning one
 * warehouse. User A holds a valid session and asks for one of user B's
 * objects by its id. The correct answer is always 404 - not 403, which
 * would confirm the id exists and turn ObjectId enumeration into a map of
 * the deployment.
 */
const request = require('supertest');
const { mockQuery } = require('../helpers/mockQuery');
const { authed, makeUser, USER_A_ID, USER_B_ID } = require('../helpers/auth');

const WAREHOUSE_A = '507f1f77bcf86cd799439011';
const WAREHOUSE_B = '507f1f77bcf86cd799439012';
const ROBOT_B = '507f1f77bcf86cd799439021';
const ORDER_B = '507f1f77bcf86cd799439022';
const STAT_B = '507f1f77bcf86cd799439023';
const LOG_B = '507f1f77bcf86cd799439024';

const modelMock = (extra = {}) => ({
  find: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findByIdAndDelete: jest.fn(),
  findOneAndDelete: jest.fn(),
  countDocuments: jest.fn(),
  ...extra,
});

jest.mock('../../src/models/Warehouse', () =>
  Object.assign(
    {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findOneAndDelete: jest.fn(),
      countDocuments: jest.fn(),
      activate: jest.fn(),
    },
    { CELL_TYPES: ['shelf', 'charging', 'obstacle', 'dock'] }
  )
);
jest.mock('../../src/models/Robot', () =>
  Object.assign(
    {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      countDocuments: jest.fn(),
    },
    { STATUSES: ['idle', 'moving', 'charging', 'error'] }
  )
);
jest.mock('../../src/models/Order', () => {
  const { STATUSES } = jest.requireActual('../../src/domain/orderLifecycle');
  return Object.assign(
    {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findByIdAndDelete: jest.fn(),
      countDocuments: jest.fn(),
    },
    { STATUSES, PRIORITIES: ['low', 'normal', 'high', 'urgent'] }
  );
});
jest.mock('../../src/models/Statistics', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  findByIdAndDelete: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../../src/models/Log', () =>
  Object.assign(
    {
      find: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      findByIdAndDelete: jest.fn(),
      countDocuments: jest.fn(),
    },
    { LEVELS: ['info', 'warn', 'error'] }
  )
);
jest.mock('../../src/services/simulationManager', () => ({
  getEngine: jest.fn().mockResolvedValue(null),
  getOrderCoordinator: jest.fn().mockResolvedValue(null),
  persistRobot: jest.fn().mockResolvedValue(),
  persistRobots: jest.fn().mockResolvedValue(),
  invalidate: jest.fn(),
  addRobotToCachedEngine: jest.fn(),
}));
jest.mock('../../src/services/orderService', () => ({
  generateOrders: jest.fn().mockResolvedValue([]),
  dispatchPendingOrders: jest.fn().mockResolvedValue([]),
  processTickEvents: jest.fn().mockResolvedValue(),
}));

const Warehouse = require('../../src/models/Warehouse');
const Robot = require('../../src/models/Robot');
const Order = require('../../src/models/Order');
const Statistics = require('../../src/models/Statistics');
const Log = require('../../src/models/Log');
const orderService = require('../../src/services/orderService');
const app = require('../../src/app');

const userA = makeUser(USER_A_ID);
const asA = (req) => authed(req, userA);

/** Both warehouses exist; A owns one, B owns the other. This mirrors what
 * `findOne({_id, ownerId})` does in the real database. */
function seedWarehouses() {
  const owners = { [WAREHOUSE_A]: USER_A_ID, [WAREHOUSE_B]: USER_B_ID };

  Warehouse.findOne.mockImplementation((filter = {}) => {
    const id = String(filter._id);
    const owner = owners[id];
    if (!owner) return Promise.resolve(null);
    if (filter.ownerId && String(filter.ownerId) !== owner) return Promise.resolve(null);
    return Promise.resolve({ _id: id, ownerId: owner, name: 'W', rows: 20, cols: 20, cells: [] });
  });

  // A's owned-warehouse list, for the unfiltered collection endpoints.
  Warehouse.find.mockReturnValue(mockQuery([{ _id: WAREHOUSE_A }]));
}

beforeEach(() => {
  jest.clearAllMocks();
  seedWarehouses();

  // Every one of B's child documents exists and is findable by id - the
  // only thing standing between user A and them is the ownership check.
  Robot.findById.mockResolvedValue({ _id: ROBOT_B, name: 'B-bot', warehouseId: WAREHOUSE_B });
  Order.findById.mockResolvedValue({ _id: ORDER_B, warehouseId: WAREHOUSE_B, status: 'pending' });
  Statistics.findById.mockResolvedValue({ _id: STAT_B, warehouseId: WAREHOUSE_B });
  Log.findById.mockResolvedValue({ _id: LOG_B, warehouseId: WAREHOUSE_B, message: 'secret' });
});

describe('unauthenticated requests', () => {
  const cases = [
    ['GET', '/api/warehouses'],
    ['GET', `/api/warehouses/${WAREHOUSE_A}`],
    ['POST', '/api/warehouses'],
    ['GET', '/api/robots'],
    ['GET', `/api/robots/${ROBOT_B}`],
    ['POST', '/api/robots'],
    ['GET', '/api/orders'],
    ['POST', '/api/orders'],
    ['GET', '/api/statistics'],
    ['GET', '/api/logs'],
    ['POST', `/api/warehouses/${WAREHOUSE_A}/tick`],
    ['POST', `/api/warehouses/${WAREHOUSE_A}/path`],
    ['POST', `/api/warehouses/${WAREHOUSE_A}/orders/generate`],
    ['POST', `/api/warehouses/${WAREHOUSE_A}/orders/dispatch`],
    ['GET', `/api/warehouses/${WAREHOUSE_A}/obstacles`],
  ];

  it.each(cases)('%s %s returns 401 with no session', async (method, path) => {
    const res = await request(app)[method.toLowerCase()](path).send({});
    expect(res.status).toBe(401);
  });

  it('leaves /api/health public so platform health checks keep working', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });
});

describe('IDOR - warehouses', () => {
  it("404s reading another user's warehouse", async () => {
    const res = await asA(request(app).get(`/api/warehouses/${WAREHOUSE_B}`));
    expect(res.status).toBe(404);
  });

  it('returns the same 404 for a warehouse that never existed (no existence oracle)', async () => {
    const missing = await asA(request(app).get('/api/warehouses/507f1f77bcf86cd799439099'));
    const someoneElses = await asA(request(app).get(`/api/warehouses/${WAREHOUSE_B}`));

    expect(missing.status).toBe(someoneElses.status);
    expect(missing.body.error.message).toBe(someoneElses.body.error.message);
  });

  it("404s updating another user's warehouse, and writes nothing", async () => {
    const res = await asA(request(app).put(`/api/warehouses/${WAREHOUSE_B}`).send({ name: 'pwned' }));
    expect(res.status).toBe(404);
    expect(Warehouse.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("404s deleting another user's warehouse, and deletes nothing", async () => {
    const res = await asA(request(app).delete(`/api/warehouses/${WAREHOUSE_B}`));
    expect(res.status).toBe(404);
    expect(Warehouse.findOneAndDelete).not.toHaveBeenCalled();
  });

  it("404s activating another user's warehouse", async () => {
    const res = await asA(request(app).patch(`/api/warehouses/${WAREHOUSE_B}/activate`));
    expect(res.status).toBe(404);
    expect(Warehouse.activate).not.toHaveBeenCalled();
  });

  it('scopes the warehouse list to the caller', async () => {
    Warehouse.find.mockReturnValue(mockQuery([]));
    Warehouse.countDocuments.mockResolvedValue(0);

    await asA(request(app).get('/api/warehouses'));

    // Scoped to what this caller can reach: their own warehouses, plus any
    // shared with them. Never the whole collection - an unscoped listing is
    // both other tenants' data and a ready-made source of ids to probe.
    expect(Warehouse.find).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [{ ownerId: USER_A_ID }, { 'collaborators.userId': USER_A_ID }],
      })
    );
  });
});

describe('IDOR - simulation controls', () => {
  it("404s ticking another user's simulation", async () => {
    const res = await asA(request(app).post(`/api/warehouses/${WAREHOUSE_B}/tick`).send({}));
    expect(res.status).toBe(404);
  });

  it("404s running pathfinding against another user's layout", async () => {
    const res = await asA(
      request(app)
        .post(`/api/warehouses/${WAREHOUSE_B}/path`)
        .send({ start: { x: 0, y: 0 }, goal: { x: 1, y: 1 } })
    );
    expect(res.status).toBe(404);
  });

  it("404s generating orders into another user's warehouse", async () => {
    const res = await asA(
      request(app).post(`/api/warehouses/${WAREHOUSE_B}/orders/generate`).send({ count: 5 })
    );
    expect(res.status).toBe(404);
    expect(orderService.generateOrders).not.toHaveBeenCalled();
  });

  it("404s dispatching another user's orders", async () => {
    const res = await asA(request(app).post(`/api/warehouses/${WAREHOUSE_B}/orders/dispatch`));
    expect(res.status).toBe(404);
    expect(orderService.dispatchPendingOrders).not.toHaveBeenCalled();
  });

  it("404s listing another user's obstacles", async () => {
    const res = await asA(request(app).get(`/api/warehouses/${WAREHOUSE_B}/obstacles`));
    expect(res.status).toBe(404);
  });

  it("404s adding an obstacle to another user's warehouse", async () => {
    const res = await asA(
      request(app)
        .post(`/api/warehouses/${WAREHOUSE_B}/obstacles`)
        .send({ id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 1 }] })
    );
    expect(res.status).toBe(404);
  });
});

describe('IDOR - robots', () => {
  it("404s reading another user's robot", async () => {
    const res = await asA(request(app).get(`/api/robots/${ROBOT_B}`));
    expect(res.status).toBe(404);
  });

  it("404s updating another user's robot, and writes nothing", async () => {
    const res = await asA(request(app).put(`/api/robots/${ROBOT_B}`).send({ name: 'pwned' }));
    expect(res.status).toBe(404);
    expect(Robot.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("404s deleting another user's robot", async () => {
    const res = await asA(request(app).delete(`/api/robots/${ROBOT_B}`));
    expect(res.status).toBe(404);
    expect(Robot.findByIdAndDelete).not.toHaveBeenCalled();
  });

  it.each([
    ['tasks', { destination: { x: 1, y: 1 } }],
    ['charge', {}],
    ['clear-error', {}],
    ['break', {}],
  ])("404s driving another user's robot via /%s", async (action, body) => {
    const res = await asA(request(app).post(`/api/robots/${ROBOT_B}/${action}`).send(body));
    expect(res.status).toBe(404);
  });

  it("404s listing robots filtered by another user's warehouse", async () => {
    const res = await asA(request(app).get(`/api/robots?warehouseId=${WAREHOUSE_B}`));
    expect(res.status).toBe(404);
    expect(Robot.find).not.toHaveBeenCalled();
  });

  it('scopes an unfiltered robot list to the warehouses the caller owns', async () => {
    Robot.find.mockReturnValue(mockQuery([]));
    Robot.countDocuments.mockResolvedValue(0);

    await asA(request(app).get('/api/robots'));

    expect(Robot.find).toHaveBeenCalledWith({ warehouseId: { $in: [WAREHOUSE_A] } });
  });

  it("404s creating a robot inside another user's warehouse", async () => {
    const res = await asA(
      request(app).post('/api/robots').send({ name: 'trojan', warehouseId: WAREHOUSE_B })
    );
    expect(res.status).toBe(404);
    expect(Robot.create).not.toHaveBeenCalled();
  });
});

describe('IDOR - orders', () => {
  it("404s reading another user's order", async () => {
    const res = await asA(request(app).get(`/api/orders/${ORDER_B}`));
    expect(res.status).toBe(404);
  });

  it("404s updating another user's order", async () => {
    const res = await asA(request(app).put(`/api/orders/${ORDER_B}`).send({ priority: 'urgent' }));
    expect(res.status).toBe(404);
    expect(Order.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("404s deleting another user's order", async () => {
    const res = await asA(request(app).delete(`/api/orders/${ORDER_B}`));
    expect(res.status).toBe(404);
  });

  it("404s creating an order inside another user's warehouse", async () => {
    const res = await asA(
      request(app).post('/api/orders').send({
        warehouseId: WAREHOUSE_B,
        pickupLocation: { x: 1, y: 1 },
        deliveryLocation: { x: 2, y: 2 },
      })
    );
    expect(res.status).toBe(404);
    expect(Order.create).not.toHaveBeenCalled();
  });

  it('scopes an unfiltered order list to the warehouses the caller owns', async () => {
    Order.find.mockReturnValue(mockQuery([]));
    Order.countDocuments.mockResolvedValue(0);

    await asA(request(app).get('/api/orders'));

    expect(Order.find).toHaveBeenCalledWith({ warehouseId: { $in: [WAREHOUSE_A] } });
  });
});

describe('IDOR - statistics', () => {
  it("404s reading another user's statistics snapshot", async () => {
    const res = await asA(request(app).get(`/api/statistics/${STAT_B}`));
    expect(res.status).toBe(404);
  });

  it("404s deleting another user's statistics snapshot", async () => {
    const res = await asA(request(app).delete(`/api/statistics/${STAT_B}`));
    expect(res.status).toBe(404);
    expect(Statistics.findByIdAndDelete).not.toHaveBeenCalled();
  });

  it("404s writing a snapshot into another user's warehouse", async () => {
    const res = await asA(
      request(app).post('/api/statistics').send({ warehouseId: WAREHOUSE_B, metrics: { activeRobots: 1 } })
    );
    expect(res.status).toBe(404);
    expect(Statistics.create).not.toHaveBeenCalled();
  });

  it('scopes an unfiltered statistics list to the warehouses the caller owns', async () => {
    Statistics.find.mockReturnValue(mockQuery([]));
    Statistics.countDocuments.mockResolvedValue(0);

    await asA(request(app).get('/api/statistics'));

    expect(Statistics.find).toHaveBeenCalledWith({ warehouseId: { $in: [WAREHOUSE_A] } });
  });
});

describe('IDOR - logs', () => {
  it("404s reading another user's log entry", async () => {
    const res = await asA(request(app).get(`/api/logs/${LOG_B}`));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it("404s deleting another user's log entry", async () => {
    const res = await asA(request(app).delete(`/api/logs/${LOG_B}`));
    expect(res.status).toBe(404);
  });

  it('scopes an unfiltered log list to the warehouses the caller owns', async () => {
    Log.find.mockReturnValue(mockQuery([]));
    Log.countDocuments.mockResolvedValue(0);

    await asA(request(app).get('/api/logs'));

    expect(Log.find).toHaveBeenCalledWith({ warehouseId: { $in: [WAREHOUSE_A] } });
  });

  it('never returns a system log with no warehouse', async () => {
    // A null-warehouse log is a server-authored system record. It has no
    // owner, so no end user may read it.
    Log.findById.mockResolvedValue({ _id: LOG_B, warehouseId: null, message: 'internal detail' });
    const res = await asA(request(app).get(`/api/logs/${LOG_B}`));
    expect(res.status).toBe(404);
  });
});

describe('successful authorization paths', () => {
  it('lets the owner read their own warehouse', async () => {
    const res = await asA(request(app).get(`/api/warehouses/${WAREHOUSE_A}`));
    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe(WAREHOUSE_A);
  });

  it('lets the owner read their own robot', async () => {
    Robot.findById.mockResolvedValue({ _id: 'r-a', name: 'A-bot', warehouseId: WAREHOUSE_A });
    const res = await asA(request(app).get(`/api/robots/507f1f77bcf86cd799439031`));
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('A-bot');
  });

  it('lets the owner create a robot in their own warehouse', async () => {
    Robot.create.mockResolvedValue({ _id: 'r-new', name: 'A-bot', warehouseId: WAREHOUSE_A });
    const res = await asA(request(app).post('/api/robots').send({ name: 'A-bot', warehouseId: WAREHOUSE_A }));
    expect(res.status).toBe(201);
  });

  it('lets the owner generate orders in their own warehouse', async () => {
    const res = await asA(
      request(app).post(`/api/warehouses/${WAREHOUSE_A}/orders/generate`).send({ count: 3 })
    );
    expect(res.status).toBe(201);
    expect(orderService.generateOrders).toHaveBeenCalledWith(WAREHOUSE_A, 3);
  });
});

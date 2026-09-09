const request = require('supertest');
const { mockQuery } = require('./helpers/mockQuery');
const { authed, mockOwnership, makeWarehouse, USER_A_ID } = require('./helpers/auth');

const VALID_ID = '507f1f77bcf86cd799439011';
const WAREHOUSE_ID = '507f1f77bcf86cd799439022';

jest.mock('../src/models/Robot', () => {
  const actualStatuses = ['idle', 'moving', 'charging', 'error'];
  const mockModel = {
    find: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findByIdAndDelete: jest.fn(),
    countDocuments: jest.fn(),
  };
  mockModel.STATUSES = actualStatuses;
  return mockModel;
});

jest.mock('../src/models/Warehouse', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  countDocuments: jest.fn(),
  CELL_TYPES: ['shelf', 'charging', 'obstacle', 'dock'],
}));

// Deleting a robot now also releases any order it was working - see
// controllers/robot.controller.js - so this suite has to model the orders
// collection too.
jest.mock('../src/models/Order', () => ({
  find: jest.fn(),
  updateMany: jest.fn(),
  // The order routes build their validators from these at import time.
  STATUSES: ['pending', 'assigned', 'picking_up', 'picked_up', 'delivering', 'delivered', 'cancelled'],
  PRIORITIES: ['low', 'normal', 'high', 'urgent'],
}));

const Robot = require('../src/models/Robot');
const Warehouse = require('../src/models/Warehouse');
const Order = require('../src/models/Order');
const app = require('../src/app');

const warehouse = makeWarehouse(WAREHOUSE_ID, USER_A_ID, { rows: 20, cols: 20 });

beforeEach(() => {
  jest.clearAllMocks();
  Order.find.mockReturnValue(mockQuery([]));
  Order.updateMany.mockResolvedValue({ modifiedCount: 0 });
  mockOwnership(Warehouse, { warehouse });
  // Every :id route resolves the robot first, then its warehouse's owner.
  Robot.findById.mockResolvedValue({ _id: VALID_ID, name: 'R1', warehouseId: WAREHOUSE_ID });
  // An unfiltered list scopes to every warehouse the caller owns.
  Warehouse.find.mockReturnValue(mockQuery([{ _id: WAREHOUSE_ID }]));
});

describe('GET /api/robots', () => {
  it('lists robots with pagination metadata', async () => {
    Robot.find.mockReturnValue(mockQuery([{ _id: VALID_ID, name: 'R1' }]));
    Robot.countDocuments.mockResolvedValue(1);

    const res = await authed(request(app).get('/api/robots'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 1, pages: 1 });
  });

  it('filters by warehouseId and status', async () => {
    Robot.find.mockReturnValue(mockQuery([]));
    Robot.countDocuments.mockResolvedValue(0);

    await authed(request(app).get(`/api/robots?warehouseId=${WAREHOUSE_ID}&status=idle`));

    expect(Robot.find).toHaveBeenCalledWith({ warehouseId: WAREHOUSE_ID, status: 'idle' });
  });

  it('scopes an unfiltered list to the warehouses the caller owns', async () => {
    Robot.find.mockReturnValue(mockQuery([]));
    Robot.countDocuments.mockResolvedValue(0);

    await authed(request(app).get('/api/robots'));

    expect(Robot.find).toHaveBeenCalledWith({ warehouseId: { $in: [WAREHOUSE_ID] } });
  });
});

describe('GET /api/robots/:id', () => {
  it('returns a single robot', async () => {
    const res = await authed(request(app).get(`/api/robots/${VALID_ID}`));
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('R1');
  });

  it('returns 404 when the robot does not exist', async () => {
    Robot.findById.mockResolvedValue(null);
    const res = await authed(request(app).get(`/api/robots/${VALID_ID}`));
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/not found/i);
  });
});

describe('POST /api/robots', () => {
  it('creates a robot with valid input', async () => {
    Robot.create.mockResolvedValue({ _id: VALID_ID, name: 'R1', warehouseId: WAREHOUSE_ID });

    const res = await authed(
      request(app).post('/api/robots').send({ name: 'R1', warehouseId: WAREHOUSE_ID, battery: 80 })
    );

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('R1');
    expect(Robot.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'R1', warehouseId: WAREHOUSE_ID, battery: 80 })
    );
  });

  it('surfaces a Mongoose ValidationError as a formatted 400', async () => {
    const validationError = new Error('Robot validation failed');
    validationError.name = 'ValidationError';
    validationError.errors = { battery: { path: 'battery', message: 'Battery must be <= 100' } };
    Robot.create.mockRejectedValue(validationError);

    const res = await authed(
      request(app).post('/api/robots').send({ name: 'R1', warehouseId: WAREHOUSE_ID, battery: 50 })
    );

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('battery');
  });
});

describe('PUT /api/robots/:id', () => {
  it('updates a robot', async () => {
    Robot.findByIdAndUpdate.mockResolvedValue({ _id: VALID_ID, name: 'R1-renamed' });
    const res = await authed(request(app).put(`/api/robots/${VALID_ID}`).send({ name: 'R1-renamed' }));
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('R1-renamed');
  });

  it('returns 404 updating a robot that does not exist', async () => {
    Robot.findById.mockResolvedValue(null);
    const res = await authed(request(app).put(`/api/robots/${VALID_ID}`).send({ name: 'X' }));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/robots/:id', () => {
  it('deletes a robot and returns 204', async () => {
    Robot.findByIdAndDelete.mockResolvedValue({ _id: VALID_ID, warehouseId: WAREHOUSE_ID });
    const res = await authed(request(app).delete(`/api/robots/${VALID_ID}`));
    expect(res.status).toBe(204);
  });

  it('releases the orders a deleted robot was carrying', async () => {
    // Without this the order document keeps naming a robot that no longer
    // exists, in a state only that robot could ever have advanced.
    Robot.findByIdAndDelete.mockResolvedValue({ _id: VALID_ID, warehouseId: WAREHOUSE_ID });
    Order.find.mockReturnValue(mockQuery([{ _id: 'o1' }]));

    const res = await authed(request(app).delete(`/api/robots/${VALID_ID}`));

    expect(res.status).toBe(204);
    expect(Order.find).toHaveBeenCalledWith(
      expect.objectContaining({ assignedRobot: VALID_ID, warehouseId: WAREHOUSE_ID })
    );
    expect(Order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: ['o1'] } }),
      { $set: { status: 'pending', assignedRobot: null, assignedAt: null, pickedUpAt: null } }
    );
  });

  it('returns 404 deleting a robot that does not exist', async () => {
    Robot.findById.mockResolvedValue(null);
    const res = await authed(request(app).delete(`/api/robots/${VALID_ID}`));
    expect(res.status).toBe(404);
  });
});

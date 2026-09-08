const request = require('supertest');
const { mockQuery } = require('./helpers/mockQuery');
const { authed, mockOwnership, makeWarehouse, USER_A_ID } = require('./helpers/auth');

const VALID_ID = '507f1f77bcf86cd799439011';
const WAREHOUSE_ID = '507f1f77bcf86cd799439022';
const ROBOT_ID = '507f1f77bcf86cd799439033';

jest.mock('../src/models/Order', () => {
  const { STATUSES } = jest.requireActual('../src/domain/orderLifecycle');
  const mockModel = {
    find: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findByIdAndDelete: jest.fn(),
    countDocuments: jest.fn(),
  };
  mockModel.STATUSES = STATUSES;
  mockModel.PRIORITIES = ['low', 'normal', 'high', 'urgent'];
  return mockModel;
});

jest.mock('../src/models/Robot', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
  STATUSES: ['idle', 'moving', 'charging', 'error'],
}));

jest.mock('../src/models/Warehouse', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
  CELL_TYPES: ['shelf', 'charging', 'obstacle', 'dock'],
}));

const Order = require('../src/models/Order');
const Robot = require('../src/models/Robot');
const Warehouse = require('../src/models/Warehouse');
const app = require('../src/app');

const warehouse = makeWarehouse(WAREHOUSE_ID, USER_A_ID, { rows: 20, cols: 20 });

/** Puts an order in a known state for the ownership middleware to resolve. */
function givenOrder(status = 'pending') {
  Order.findById.mockResolvedValue({
    _id: VALID_ID,
    warehouseId: WAREHOUSE_ID,
    status,
    pickupLocation: { x: 1, y: 1 },
    deliveryLocation: { x: 5, y: 5 },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOwnership(Warehouse, { warehouse });
  Warehouse.find.mockReturnValue(mockQuery([{ _id: WAREHOUSE_ID }]));
  Robot.findOne.mockReturnValue(mockQuery({ _id: ROBOT_ID }));
  givenOrder('pending');
});

describe('POST /api/orders', () => {
  it('creates an order with pickup/delivery locations', async () => {
    const payload = {
      warehouseId: WAREHOUSE_ID,
      pickupLocation: { x: 1, y: 1 },
      deliveryLocation: { x: 5, y: 5 },
    };
    Order.create.mockResolvedValue({ _id: VALID_ID, ...payload, status: 'pending' });

    const res = await authed(request(app).post('/api/orders').send(payload));
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
  });
});

describe('PUT /api/orders/:id - lifecycle timestamps', () => {
  it('stamps assignedAt when status moves to assigned', async () => {
    Order.findByIdAndUpdate.mockResolvedValue({ _id: VALID_ID, status: 'assigned' });

    await authed(
      request(app).put(`/api/orders/${VALID_ID}`).send({ status: 'assigned', assignedRobot: ROBOT_ID })
    );

    const [, payload] = Order.findByIdAndUpdate.mock.calls[0];
    expect(payload.$set.status).toBe('assigned');
    expect(payload.$set.assignedAt).toBeInstanceOf(Date);
  });

  it('stamps deliveredAt when status moves to delivered', async () => {
    givenOrder('picked_up'); // delivered is only reachable from picked_up/delivering
    Order.findByIdAndUpdate.mockResolvedValue({ _id: VALID_ID, status: 'delivered' });

    await authed(request(app).put(`/api/orders/${VALID_ID}`).send({ status: 'delivered' }));

    const [, payload] = Order.findByIdAndUpdate.mock.calls[0];
    expect(payload.$set.deliveredAt).toBeInstanceOf(Date);
  });

  it('refuses a client-supplied lifecycle timestamp and stamps its own', async () => {
    // Previously an explicit `pickedUpAt` in the body was written through
    // verbatim, letting a client backdate (or forward-date) a step of the
    // lifecycle. Timestamps are now facts the server records.
    givenOrder('assigned');

    const res = await authed(
      request(app)
        .put(`/api/orders/${VALID_ID}`)
        .send({ status: 'picked_up', pickedUpAt: '2026-01-01T00:00:00.000Z' })
    );

    expect(res.status).toBe(422);
    expect(res.body.error.details.fields).toContain('pickedUpAt');
    expect(Order.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects an invalid assignedRobot id', async () => {
    const res = await authed(
      request(app).put(`/api/orders/${VALID_ID}`).send({ assignedRobot: 'not-an-id' })
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/orders', () => {
  it('filters by status and priority', async () => {
    Order.find.mockReturnValue(mockQuery([]));
    Order.countDocuments.mockResolvedValue(0);

    await authed(request(app).get(`/api/orders?warehouseId=${WAREHOUSE_ID}&status=pending&priority=high`));

    expect(Order.find).toHaveBeenCalledWith({
      warehouseId: WAREHOUSE_ID,
      status: 'pending',
      priority: 'high',
    });
  });
});

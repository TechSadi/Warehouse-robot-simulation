const request = require('supertest');
const { mockQuery } = require('./helpers/mockQuery');

const VALID_ID = '507f1f77bcf86cd799439011';
const WAREHOUSE_ID = '507f1f77bcf86cd799439022';
const ROBOT_ID = '507f1f77bcf86cd799439033';

jest.mock('../src/models/Order', () => {
  const mockModel = {
    find: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findByIdAndDelete: jest.fn(),
    countDocuments: jest.fn(),
  };
  mockModel.STATUSES = ['pending', 'assigned', 'picked_up', 'delivered', 'cancelled'];
  mockModel.PRIORITIES = ['low', 'normal', 'high', 'urgent'];
  return mockModel;
});

const Order = require('../src/models/Order');
const app = require('../src/app');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/orders', () => {
  it('creates an order with pickup/delivery locations', async () => {
    const payload = {
      warehouseId: WAREHOUSE_ID,
      pickupLocation: { x: 1, y: 1 },
      deliveryLocation: { x: 5, y: 5 },
    };
    Order.create.mockResolvedValue({ _id: VALID_ID, ...payload, status: 'pending' });

    const res = await request(app).post('/api/orders').send(payload);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
  });
});

describe('PUT /api/orders/:id - lifecycle timestamps', () => {
  it('stamps assignedAt when status moves to assigned', async () => {
    Order.findByIdAndUpdate.mockResolvedValue({ _id: VALID_ID, status: 'assigned' });

    await request(app)
      .put(`/api/orders/${VALID_ID}`)
      .send({ status: 'assigned', assignedRobot: ROBOT_ID });

    const [, payload] = Order.findByIdAndUpdate.mock.calls[0];
    expect(payload.status).toBe('assigned');
    expect(payload.assignedAt).toBeInstanceOf(Date);
  });

  it('stamps deliveredAt when status moves to delivered', async () => {
    Order.findByIdAndUpdate.mockResolvedValue({ _id: VALID_ID, status: 'delivered' });

    await request(app).put(`/api/orders/${VALID_ID}`).send({ status: 'delivered' });

    const [, payload] = Order.findByIdAndUpdate.mock.calls[0];
    expect(payload.deliveredAt).toBeInstanceOf(Date);
  });

  it('does not overwrite an explicitly provided timestamp', async () => {
    Order.findByIdAndUpdate.mockResolvedValue({ _id: VALID_ID, status: 'picked_up' });
    const explicitDate = '2026-01-01T00:00:00.000Z';

    await request(app)
      .put(`/api/orders/${VALID_ID}`)
      .send({ status: 'picked_up', pickedUpAt: explicitDate });

    const [, payload] = Order.findByIdAndUpdate.mock.calls[0];
    expect(payload.pickedUpAt).toBe(explicitDate);
  });

  it('rejects an invalid assignedRobot id', async () => {
    const res = await request(app)
      .put(`/api/orders/${VALID_ID}`)
      .send({ assignedRobot: 'not-an-id' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/orders', () => {
  it('filters by status and priority', async () => {
    Order.find.mockReturnValue(mockQuery([]));
    Order.countDocuments.mockResolvedValue(0);

    await request(app).get('/api/orders?status=pending&priority=high');

    expect(Order.find).toHaveBeenCalledWith({ status: 'pending', priority: 'high' });
  });
});

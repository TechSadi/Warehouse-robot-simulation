const request = require('supertest');

const WAREHOUSE_ID = '507f1f77bcf86cd799439022';

jest.mock('../../src/services/orderService', () => ({
  generateOrders: jest.fn(),
  dispatchPendingOrders: jest.fn(),
  processTickEvents: jest.fn(),
}));

jest.mock('../../src/services/simulationManager', () => ({
  getEngine: jest.fn(),
  getOrderCoordinator: jest.fn(),
  persistRobot: jest.fn(),
  invalidate: jest.fn(),
}));

const orderService = require('../../src/services/orderService');
const app = require('../../src/app');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/warehouses/:id/orders/generate', () => {
  it('generates orders and returns them', async () => {
    const orders = [
      { _id: 'o1', priority: 'normal' },
      { _id: 'o2', priority: 'high' },
    ];
    orderService.generateOrders.mockResolvedValue(orders);

    const res = await request(app)
      .post(`/api/warehouses/${WAREHOUSE_ID}/orders/generate`)
      .send({ count: 2 });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual(orders);
    expect(orderService.generateOrders).toHaveBeenCalledWith(WAREHOUSE_ID, 2);
  });

  it('defaults count to 5 when not provided', async () => {
    orderService.generateOrders.mockResolvedValue([]);
    await request(app).post(`/api/warehouses/${WAREHOUSE_ID}/orders/generate`).send({});
    expect(orderService.generateOrders).toHaveBeenCalledWith(WAREHOUSE_ID, 5);
  });

  it('rejects a count outside the allowed range', async () => {
    const res = await request(app)
      .post(`/api/warehouses/${WAREHOUSE_ID}/orders/generate`)
      .send({ count: 500 });
    expect(res.status).toBe(400);
  });

  it('propagates a 422 when the layout has no room to generate orders', async () => {
    const { ApiError } = require('../../src/middleware/errorHandler');
    orderService.generateOrders.mockRejectedValue(new ApiError(422, 'Cannot generate orders: warehouse needs at least 2 walkable cells'));

    const res = await request(app).post(`/api/warehouses/${WAREHOUSE_ID}/orders/generate`).send({});
    expect(res.status).toBe(422);
  });
});

describe('POST /api/warehouses/:id/orders/dispatch', () => {
  it('dispatches pending orders and returns the assignments made', async () => {
    const assignments = [{ orderId: 'o1', robotId: 'r1' }];
    orderService.dispatchPendingOrders.mockResolvedValue(assignments);

    const res = await request(app).post(`/api/warehouses/${WAREHOUSE_ID}/orders/dispatch`);

    expect(res.status).toBe(200);
    expect(res.body.data.assignments).toEqual(assignments);
    expect(res.body.data.count).toBe(1);
    expect(orderService.dispatchPendingOrders).toHaveBeenCalledWith(WAREHOUSE_ID);
  });

  it('returns an empty assignment list when nothing can be dispatched', async () => {
    orderService.dispatchPendingOrders.mockResolvedValue([]);
    const res = await request(app).post(`/api/warehouses/${WAREHOUSE_ID}/orders/dispatch`);
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(0);
  });
});

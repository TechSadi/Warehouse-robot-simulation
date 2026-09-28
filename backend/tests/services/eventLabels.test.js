const WAREHOUSE_ID = '507f1f77bcf86cd799439022';

jest.mock('../../src/models/Order', () => ({
  find: jest.fn(),
  bulkWrite: jest.fn(),
}));

jest.mock('../../src/models/Log', () => ({
  create: jest.fn(),
}));

const Order = require('../../src/models/Order');
const Log = require('../../src/models/Log');
const simulationManager = require('../../src/services/simulationManager');
const simulationEvents = require('../../src/events/simulationEvents');
const orderService = require('../../src/services/orderService');
const { robotLabel, orderLabel, shortId } = require('../../src/utils/eventLabels');

describe('eventLabels', () => {
  it('names a robot the way the fleet roster does', () => {
    expect(robotLabel('Robot 3', '6aba4c2d077253c0a3d9b77c')).toBe('Robot 3');
  });

  it('falls back to a short id when the robot name is unknown', () => {
    expect(robotLabel(undefined, '6aba4c2d077253c0a3d9b77c')).toBe('robot #d9b77c');
  });

  it('names an order by its route, like the orders panel', () => {
    const order = { pickupLocation: { x: 22, y: 4 }, deliveryLocation: { x: 15, y: 0 } };
    expect(orderLabel(order, 'x')).toBe('order (22,4) → (15,0)');
  });

  it('falls back to a short id when the order is not found', () => {
    expect(orderLabel(undefined, '6aba4c36077253c0a3d9b798')).toBe('order #d9b798');
  });

  it('leaves short ids alone', () => {
    expect(shortId('r1')).toBe('r1');
  });
});

describe('processTickEvents messages', () => {
  let notifications;
  const listener = (payload) => notifications.push(payload);

  beforeEach(() => {
    jest.clearAllMocks();
    notifications = [];
    simulationEvents.on('notification', listener);
  });

  afterEach(() => {
    simulationEvents.off('notification', listener);
    jest.restoreAllMocks();
  });

  function mockOrders(docs) {
    Order.find.mockReturnValue({ select: jest.fn().mockResolvedValue(docs) });
  }

  it('says which robot delivered which order, without database ids', async () => {
    jest.spyOn(simulationManager, 'peekEngine').mockResolvedValue({ getRobot: () => ({ name: 'Robot 3' }) });
    mockOrders([{ _id: 'o1', pickupLocation: { x: 22, y: 4 }, deliveryLocation: { x: 15, y: 0 } }]);

    await orderService.processTickEvents(WAREHOUSE_ID, [{ type: 'delivered', robotId: 'r1', orderId: 'o1' }]);

    expect(notifications.map((n) => n.message)).toEqual(['Robot 3 delivered order (22,4) → (15,0)']);
  });

  it('writes deliveries to the log, not only to the live feed', async () => {
    jest.spyOn(simulationManager, 'peekEngine').mockResolvedValue({ getRobot: () => ({ name: 'Robot 3' }) });
    mockOrders([{ _id: 'o1', pickupLocation: { x: 22, y: 4 }, deliveryLocation: { x: 15, y: 0 } }]);

    await orderService.processTickEvents(WAREHOUSE_ID, [{ type: 'delivered', robotId: 'r1', orderId: 'o1' }]);

    expect(Log.create).toHaveBeenCalledWith({
      level: 'info',
      source: 'order-service',
      message: 'Robot 3 delivered order (22,4) → (15,0)',
      warehouseId: WAREHOUSE_ID,
    });
  });

  it('names the robot and order in the log when an order is released', async () => {
    jest.spyOn(simulationManager, 'peekEngine').mockResolvedValue({ getRobot: () => ({ name: 'Robot 7' }) });
    mockOrders([{ _id: 'o1', pickupLocation: { x: 1, y: 2 }, deliveryLocation: { x: 3, y: 0 } }]);

    await orderService.processTickEvents(WAREHOUSE_ID, [
      { type: 'order_failed', robotId: 'r1', orderId: 'o1', reason: 'Battery depleted' },
    ]);

    expect(Log.create).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Order (1,2) → (3,0) released back to pending: Robot 7 failed (Battery depleted)',
      })
    );
  });

  it('still writes the message with short ids if the lookups fail', async () => {
    jest.spyOn(simulationManager, 'peekEngine').mockRejectedValue(new Error('no engine'));
    Order.find.mockImplementation(() => {
      throw new Error('db down');
    });

    await orderService.processTickEvents(WAREHOUSE_ID, [
      { type: 'delivered', robotId: '6aba4c2d077253c0a3d9b77c', orderId: '6aba4c36077253c0a3d9b798' },
    ]);

    expect(notifications.map((n) => n.message)).toEqual(['Robot #d9b77c delivered order #d9b798']);
  });

  it('skips the order lookup on ticks with nothing to report', async () => {
    await orderService.processTickEvents(WAREHOUSE_ID, [{ type: 'picked_up', robotId: 'r1', orderId: 'o1' }]);
    expect(Order.find).not.toHaveBeenCalled();
  });
});

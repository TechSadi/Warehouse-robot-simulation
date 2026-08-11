const WAREHOUSE_ID = '507f1f77bcf86cd799439022';

jest.mock('../../src/models/Warehouse', () => ({
  findById: jest.fn(),
}));

jest.mock('../../src/models/Robot', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  bulkWrite: jest.fn(),
}));

jest.mock('../../src/models/Order', () => ({
  find: jest.fn(),
  insertMany: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  bulkWrite: jest.fn(),
}));

jest.mock('../../src/models/Log', () => ({
  create: jest.fn(),
}));

const Warehouse = require('../../src/models/Warehouse');
const Robot = require('../../src/models/Robot');
const Order = require('../../src/models/Order');
const Log = require('../../src/models/Log');
const simulationManager = require('../../src/services/simulationManager');
const orderService = require('../../src/services/orderService');

function mockQuery(value) {
  return {
    select: jest.fn().mockResolvedValue(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    catch: (reject) => Promise.resolve(value).catch(reject),
  };
}

function openWarehouseDoc(overrides = {}) {
  return { rows: 10, cols: 10, cells: [], ...overrides };
}

function robotDoc(id, overrides = {}) {
  return {
    _id: id,
    name: id,
    position: { x: 0, y: 0 },
    speed: 100,
    battery: 100,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  simulationManager.invalidate(WAREHOUSE_ID);
  Order.findByIdAndUpdate.mockResolvedValue({});
  Order.bulkWrite.mockResolvedValue({});
  Robot.findByIdAndUpdate.mockResolvedValue({});
  Robot.bulkWrite.mockResolvedValue({});
  Log.create.mockResolvedValue({});
});

describe('dispatchPendingOrders', () => {
  it('assigns pending orders according to the warehouse-configured strategy (round_robin)', async () => {
    Warehouse.findById.mockReturnValue(mockQuery({ ...openWarehouseDoc(), schedulingStrategy: 'round_robin' }));
    Robot.find.mockResolvedValue([robotDoc('r1', { position: { x: 0, y: 0 } }), robotDoc('r2', { position: { x: 9, y: 9 } })]);
    Order.find.mockResolvedValue([
      { _id: 'o1', priority: 'normal', createdAt: new Date(1000), pickupLocation: { x: 0, y: 1 }, deliveryLocation: { x: 0, y: 2 } },
      { _id: 'o2', priority: 'normal', createdAt: new Date(2000), pickupLocation: { x: 0, y: 1 }, deliveryLocation: { x: 0, y: 2 } },
    ]);

    const assignments = await orderService.dispatchPendingOrders(WAREHOUSE_ID);

    // round_robin should spread the two orders across both robots, not
    // both going to the nearer one (which "nearest" would do instead).
    expect(assignments.map((a) => a.robotId).sort()).toEqual(['r1', 'r2']);
    // Milestone 14: one bulk write covers both robots' new task-queue
    // state, not one findByIdAndUpdate call per assignment.
    expect(Robot.bulkWrite).toHaveBeenCalledTimes(1);
    expect(Robot.bulkWrite.mock.calls[0][0]).toHaveLength(2);
    expect(Order.bulkWrite).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: { _id: 'o1' },
            update: expect.objectContaining({ status: 'assigned', assignedRobot: expect.any(String) }),
          }),
        }),
      ]),
      { ordered: false }
    );
  });

  it('prefers the nearest robot when the strategy is nearest_robot', async () => {
    Warehouse.findById.mockReturnValue(mockQuery({ ...openWarehouseDoc(), schedulingStrategy: 'nearest_robot' }));
    Robot.find.mockResolvedValue([robotDoc('far', { position: { x: 9, y: 9 } }), robotDoc('near', { position: { x: 1, y: 0 } })]);
    Order.find.mockResolvedValue([
      { _id: 'o1', priority: 'normal', createdAt: new Date(), pickupLocation: { x: 0, y: 0 }, deliveryLocation: { x: 0, y: 5 } },
    ]);

    const assignments = await orderService.dispatchPendingOrders(WAREHOUSE_ID);
    expect(assignments).toEqual([{ orderId: 'o1', robotId: 'near' }]);
  });

  it('dispatches the urgent order before an older normal one under priority_queue', async () => {
    Warehouse.findById.mockReturnValue(mockQuery({ ...openWarehouseDoc(), schedulingStrategy: 'priority_queue' }));
    Robot.find.mockResolvedValue([robotDoc('only', { position: { x: 0, y: 0 } })]);
    Order.find.mockResolvedValue([
      { _id: 'old-normal', priority: 'normal', createdAt: new Date(1000), pickupLocation: { x: 5, y: 5 }, deliveryLocation: { x: 9, y: 9 } },
      { _id: 'new-urgent', priority: 'urgent', createdAt: new Date(9000), pickupLocation: { x: 1, y: 1 }, deliveryLocation: { x: 9, y: 9 } },
    ]);

    const assignments = await orderService.dispatchPendingOrders(WAREHOUSE_ID);
    expect(assignments).toEqual([{ orderId: 'new-urgent', robotId: 'only' }]);
  });

  it('leaves an order pending (does not assign it) when its pickup point is unreachable', async () => {
    // A wall with no gap between the robot and the pickup point.
    const wall = Array.from({ length: 10 }, (_, y) => ({ x: 5, y, type: 'obstacle' }));
    Warehouse.findById.mockReturnValue(mockQuery({ ...openWarehouseDoc({ cells: wall }), schedulingStrategy: 'fcfs' }));
    Robot.find.mockResolvedValue([robotDoc('r1', { position: { x: 0, y: 0 } })]);
    Order.find.mockResolvedValue([
      { _id: 'o1', priority: 'normal', createdAt: new Date(), pickupLocation: { x: 9, y: 0 }, deliveryLocation: { x: 9, y: 9 } },
    ]);

    const assignments = await orderService.dispatchPendingOrders(WAREHOUSE_ID);
    expect(assignments).toEqual([]);
    expect(Order.bulkWrite).not.toHaveBeenCalled();
  });

  it('returns 404 when the warehouse does not exist', async () => {
    Warehouse.findById.mockReturnValue(mockQuery(null));
    await expect(orderService.dispatchPendingOrders(WAREHOUSE_ID)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('generateOrders', () => {
  it('generates and persists the requested number of orders', async () => {
    Warehouse.findById.mockResolvedValue(openWarehouseDoc());
    const created = [{ _id: 'o1' }, { _id: 'o2' }];
    Order.insertMany.mockResolvedValue(created);

    const result = await orderService.generateOrders(WAREHOUSE_ID, 2);
    expect(result).toEqual(created);
    expect(Log.create).toHaveBeenCalledWith(expect.objectContaining({ level: 'info' }));
  });

  it('returns a 422 when the layout has no room to generate orders', async () => {
    Warehouse.findById.mockResolvedValue({ rows: 1, cols: 1, cells: [{ x: 0, y: 0, type: 'obstacle' }] });
    await expect(orderService.generateOrders(WAREHOUSE_ID, 1)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('returns a 404 when the warehouse does not exist', async () => {
    Warehouse.findById.mockResolvedValue(null);
    await expect(orderService.generateOrders(WAREHOUSE_ID, 1)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('processTickEvents', () => {
  it('persists pickup and delivery status transitions', async () => {
    await orderService.processTickEvents(WAREHOUSE_ID, [
      { type: 'picked_up', robotId: 'r1', orderId: 'o1' },
      { type: 'delivered', robotId: 'r1', orderId: 'o2' },
    ]);

    // Milestone 14: one bulk write instead of one findByIdAndUpdate per
    // event, ordered:true so a same-order picked_up-then-delivered pair
    // (not possible today - see the comment in orderService.js - but
    // cheap to guard against) can never apply out of sequence.
    expect(Order.bulkWrite).toHaveBeenCalledWith(
      [
        { updateOne: { filter: { _id: 'o1' }, update: expect.objectContaining({ status: 'picked_up' }) } },
        { updateOne: { filter: { _id: 'o2' }, update: expect.objectContaining({ status: 'delivered' }) } },
      ],
      { ordered: true }
    );
  });

  it('increments the completed-order count used by the least_busy strategy', async () => {
    await orderService.processTickEvents(WAREHOUSE_ID, [{ type: 'delivered', robotId: 'r1', orderId: 'o1' }]);
    await orderService.processTickEvents(WAREHOUSE_ID, [{ type: 'delivered', robotId: 'r1', orderId: 'o2' }]);

    const state = simulationManager.getSchedulerState(WAREHOUSE_ID);
    expect(state.completedCounts.get('r1')).toBe(2);
  });

  it('logs a warning when a delivery becomes unreachable', async () => {
    await orderService.processTickEvents(WAREHOUSE_ID, [
      { type: 'delivery_unreachable', robotId: 'r1', orderId: 'o1' },
    ]);
    expect(Log.create).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
  });

  it('does not call bulkWrite when there are no order-affecting events', async () => {
    await orderService.processTickEvents(WAREHOUSE_ID, [
      { type: 'delivery_unreachable', robotId: 'r1', orderId: 'o1' },
    ]);
    expect(Order.bulkWrite).not.toHaveBeenCalled();
  });
});

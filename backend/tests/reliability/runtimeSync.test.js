/**
 * Runtime/database synchronisation and restart recovery.
 *
 * The class of bug these cover is a resource existing in MongoDB that the
 * running SimulationManager does not know about, or vice versa - a robot
 * created while a simulation is running that never joins the fleet, a
 * deleted robot that keeps moving and blocking cells, and a process
 * restart that leaves Mongo describing a simulation nobody is running.
 */
const WAREHOUSE_ID = '507f1f77bcf86cd799439022';

jest.mock('../../src/models/Warehouse', () => ({ findById: jest.fn() }));
jest.mock('../../src/models/Robot', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  bulkWrite: jest.fn(),
}));
jest.mock('../../src/models/Order', () => ({
  find: jest.fn(),
  updateMany: jest.fn(),
  bulkWrite: jest.fn(),
}));
jest.mock('../../src/models/Log', () => ({ create: jest.fn() }));

const Warehouse = require('../../src/models/Warehouse');
const Robot = require('../../src/models/Robot');
const Order = require('../../src/models/Order');
const Log = require('../../src/models/Log');
const simulationManager = require('../../src/services/simulationManager');
const orderService = require('../../src/services/orderService');
const tickRunner = require('../../src/services/tickRunner');
const warehouseLock = require('../../src/services/warehouseLock');

function mockQuery(value) {
  const query = {
    select: jest.fn(() => query),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    catch: (reject) => Promise.resolve(value).catch(reject),
  };
  return query;
}

const CHARGING_CELL = { x: 9, y: 9, type: 'charging' };

function warehouseDoc(overrides = {}) {
  return {
    _id: WAREHOUSE_ID,
    rows: 10,
    cols: 10,
    cells: [CHARGING_CELL],
    schedulingStrategy: 'nearest_robot',
    ...overrides,
  };
}

function robotDoc(id, position, overrides = {}) {
  return { _id: id, name: id, position, speed: 1, battery: 100, status: 'idle', errorReason: null, ...overrides };
}

/** Every `updateOne` a bulkWrite call was given, flattened. */
function bulkOps(mock) {
  return mock.mock.calls.flatMap(([ops]) => ops);
}

beforeEach(() => {
  jest.clearAllMocks();
  warehouseLock._reset();
  simulationManager.invalidate(WAREHOUSE_ID);
  tickRunner.forgetWarehouse(WAREHOUSE_ID);

  Warehouse.findById.mockReturnValue(mockQuery(warehouseDoc()));
  Robot.find.mockResolvedValue([]);
  Robot.bulkWrite.mockResolvedValue({});
  Robot.findByIdAndUpdate.mockResolvedValue({});
  Order.find.mockResolvedValue([]);
  Order.updateMany.mockResolvedValue({ modifiedCount: 0 });
  Order.bulkWrite.mockResolvedValue({});
  Log.create.mockResolvedValue({});
});

describe('one engine per warehouse', () => {
  it('builds exactly one engine even when several callers race for it', async () => {
    // With a plain instance cache, each of these missed the cache, built
    // its own RobotEngine and wrote it to the map - the losers went on
    // running as detached simulations of the same warehouse.
    const engines = await Promise.all([
      simulationManager.getEngine(WAREHOUSE_ID),
      simulationManager.getEngine(WAREHOUSE_ID),
      simulationManager.getEngine(WAREHOUSE_ID),
    ]);

    expect(engines[0]).toBe(engines[1]);
    expect(engines[1]).toBe(engines[2]);
    expect(Robot.find).toHaveBeenCalledTimes(1); // seeded once, not three times
  });

  it('binds the order coordinator to the engine that is actually live', async () => {
    const [engine, coordinator] = await Promise.all([
      simulationManager.getEngine(WAREHOUSE_ID),
      simulationManager.getOrderCoordinator(WAREHOUSE_ID),
    ]);
    expect(coordinator.engine).toBe(engine);

    // After an invalidation both are rebuilt, and must still match.
    simulationManager.invalidate(WAREHOUSE_ID);
    const rebuiltCoordinator = await simulationManager.getOrderCoordinator(WAREHOUSE_ID);
    const rebuiltEngine = await simulationManager.getEngine(WAREHOUSE_ID);
    expect(rebuiltCoordinator.engine).toBe(rebuiltEngine);
    expect(rebuiltEngine).not.toBe(engine);
  });

  it('does not cache a warehouse that does not exist', async () => {
    Warehouse.findById.mockReturnValue(mockQuery(null));
    expect(await simulationManager.getEngine(WAREHOUSE_ID)).toBeNull();
    expect(simulationManager.hasEngine(WAREHOUSE_ID)).toBe(false);

    // Creating it a moment later must be visible immediately.
    Warehouse.findById.mockReturnValue(mockQuery(warehouseDoc()));
    expect(await simulationManager.getEngine(WAREHOUSE_ID)).not.toBeNull();
  });

  it('does not cache a failed load, so one bad read is not permanent', async () => {
    Robot.find.mockRejectedValueOnce(new Error('mongo is down'));
    await expect(simulationManager.getEngine(WAREHOUSE_ID)).rejects.toThrow('mongo is down');
    expect(simulationManager.hasEngine(WAREHOUSE_ID)).toBe(false);
    await expect(simulationManager.getEngine(WAREHOUSE_ID)).resolves.not.toBeNull();
  });
});

describe('robot creation during an active simulation', () => {
  it('joins the live fleet immediately, without a reload', async () => {
    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    expect(engine.getAllRobots()).toHaveLength(0);

    const snapshot = await simulationManager.addRobotToCachedEngine(
      WAREHOUSE_ID,
      robotDoc('new-robot', { x: 1, y: 1 })
    );

    expect(snapshot).toMatchObject({ id: 'new-robot', status: 'idle', position: { x: 1, y: 1 } });
    expect(engine.getRobot('new-robot')).not.toBeNull();

    // And it is a full participant: it moves on the very next tick.
    engine.assignTask('new-robot', { x: 4, y: 1 });
    await tickRunner.runTick(WAREHOUSE_ID, 1);
    expect(engine.getRobot('new-robot').position).toEqual({ x: 2, y: 1 });
  });

  it('reports failure rather than half-registering an unplaceable robot', async () => {
    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    await simulationManager.addRobotToCachedEngine(WAREHOUSE_ID, robotDoc('a', { x: 2, y: 2 }));

    // Same cell as `a`: the engine refuses it, and the caller is told.
    const clash = await simulationManager.addRobotToCachedEngine(WAREHOUSE_ID, robotDoc('b', { x: 2, y: 2 }));

    expect(clash).toBeNull();
    expect(engine.getAllRobots()).toHaveLength(1);
  });

  it('is a no-op when nothing is loaded - the next load reads it from Mongo', async () => {
    expect(simulationManager.hasEngine(WAREHOUSE_ID)).toBe(false);
    const snapshot = await simulationManager.addRobotToCachedEngine(WAREHOUSE_ID, robotDoc('r9', { x: 0, y: 0 }));
    expect(snapshot).toBeNull();

    Robot.find.mockResolvedValue([robotDoc('r9', { x: 0, y: 0 })]);
    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    expect(engine.getRobot('r9')).not.toBeNull();
  });
});

describe('robot deletion during an active simulation', () => {
  it('removes it from the live fleet so it stops moving and stops blocking cells', async () => {
    Robot.find.mockResolvedValue([robotDoc('ghost', { x: 2, y: 0 }), robotDoc('mover', { x: 0, y: 0 })]);
    const engine = await simulationManager.getEngine(WAREHOUSE_ID);

    // With `ghost` present, `mover` cannot pass straight through (2,0).
    await simulationManager.removeRobotFromCachedEngine(WAREHOUSE_ID, 'ghost');

    expect(engine.getRobot('ghost')).toBeNull();
    expect(engine.getAllRobots().map((r) => r.id)).toEqual(['mover']);

    engine.assignTask('mover', { x: 4, y: 0 });
    await tickRunner.runTick(WAREHOUSE_ID, 2);
    // Straight through the cell the deleted robot used to occupy.
    expect(engine.getRobot('mover').position).toEqual({ x: 2, y: 0 });
  });

  it('reports the order the deleted robot was carrying, so it can be released', async () => {
    Robot.find.mockResolvedValue([robotDoc('carrier', { x: 0, y: 0 })]);
    const coordinator = await simulationManager.getOrderCoordinator(WAREHOUSE_ID);
    coordinator.assignOrder('carrier', {
      orderId: 'o1',
      pickupLocation: { x: 3, y: 0 },
      deliveryLocation: { x: 5, y: 0 },
    });
    expect(coordinator.isRobotOnOrder('carrier')).toBe(true);

    const released = await simulationManager.removeRobotFromCachedEngine(WAREHOUSE_ID, 'carrier');

    expect(released).toEqual(['o1']);
    expect(coordinator.isRobotOnOrder('carrier')).toBe(false);
  });

  it('returns the stranded orders to the dispatchable pool', async () => {
    Order.find.mockReturnValue(mockQuery([{ _id: 'o2' }]));

    await orderService.releaseOrdersForRobot(WAREHOUSE_ID, 'carrier', ['o1']);

    expect(Order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: expect.arrayContaining(['o1', 'o2']) } }),
      { $set: { status: 'pending', assignedRobot: null, assignedAt: null, pickedUpAt: null } }
    );
  });
});

describe('server restart recovery', () => {
  it('does not resume a robot persisted as moving - it reloads idle, and Mongo is corrected', async () => {
    // The path a `moving` robot was following lived only in memory, and
    // the world may have changed under it. Leaving Mongo saying `moving`
    // meant every list endpoint and every statistic reported a busy fleet
    // that was not moving at all.
    Robot.find.mockResolvedValue([robotDoc('r1', { x: 3, y: 3 }, { status: 'moving' })]);

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);

    expect(engine.getRobot('r1').status).toBe('idle');
    expect(bulkOps(Robot.bulkWrite)).toContainEqual({
      updateOne: {
        filter: { _id: 'r1' },
        update: expect.objectContaining({ status: 'idle', position: { x: 3, y: 3 } }),
      },
    });
  });

  it('resumes charging for a robot parked on a charging cell', async () => {
    Robot.find.mockResolvedValue([
      robotDoc('r1', { x: CHARGING_CELL.x, y: CHARGING_CELL.y }, { status: 'charging', battery: 40 }),
    ]);

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);

    expect(engine.getRobot('r1').status).toBe('charging');
    expect(Robot.bulkWrite).not.toHaveBeenCalled(); // nothing to correct
  });

  it('does not resume charging for a robot no longer standing on a charger', async () => {
    Robot.find.mockResolvedValue([robotDoc('r1', { x: 1, y: 1 }, { status: 'charging', battery: 40 })]);

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);

    expect(engine.getRobot('r1').status).toBe('idle');
  });

  it('keeps a broken robot broken - a restart is not a repair', async () => {
    Robot.find.mockResolvedValue([
      robotDoc('r1', { x: 2, y: 2 }, { status: 'error', errorReason: 'Battery depleted' }),
    ]);

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);

    expect(engine.getRobot('r1')).toMatchObject({ status: 'error', errorReason: 'Battery depleted' });
    expect(Robot.bulkWrite).not.toHaveBeenCalled();
  });

  it('reloads a robot persisted mid-move onto the whole cell it was nearest', async () => {
    // Found by an end-to-end run against a real database: a moving robot's
    // position is interpolated *between* cells, and whatever fraction it
    // was at when the process stopped is what Mongo holds. The engine is a
    // grid simulation, so seeding from a fractional position left the
    // robot out of the fleet entirely - a restart mid-move silently lost
    // every robot that happened to be between two cells.
    Robot.find.mockResolvedValue([robotDoc('r1', { x: 3.7, y: 2.2 }, { status: 'moving' })]);

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);

    expect(engine.getRobot('r1')).toMatchObject({ status: 'idle', position: { x: 4, y: 2 } });
    expect(bulkOps(Robot.bulkWrite)).toContainEqual({
      updateOne: {
        filter: { _id: 'r1' },
        update: expect.objectContaining({ status: 'idle', position: { x: 4, y: 2 } }),
      },
    });
  });

  it('marks a robot Mongo describes but the engine cannot place', async () => {
    // A shelf grew over its saved cell while the process was down. It used
    // to be dropped silently: absent from the simulation, but still listed
    // through the API as a healthy idle robot.
    Warehouse.findById.mockReturnValue(mockQuery(warehouseDoc({ cells: [{ x: 4, y: 4, type: 'shelf' }] })));
    Robot.find.mockResolvedValue([robotDoc('buried', { x: 4, y: 4 })]);

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);

    expect(engine.getRobot('buried')).toBeNull();
    expect(bulkOps(Robot.bulkWrite)).toContainEqual({
      updateOne: {
        filter: { _id: 'buried' },
        update: expect.objectContaining({ status: 'error', errorReason: expect.stringContaining('Not loaded') }),
      },
    });
  });

  it('releases every in-flight order, which nothing else could ever have advanced', async () => {
    // The OrderCoordinator's assignment map is what turns "a robot
    // arrived" into "an order advanced", and it does not survive a
    // restart. Without this, those orders sat in an in-flight state
    // forever: not delivered, and invisible to a dispatcher that only
    // looks at `pending`.
    await simulationManager.getEngine(WAREHOUSE_ID);

    expect(Order.updateMany).toHaveBeenCalledWith(
      { warehouseId: WAREHOUSE_ID, status: { $in: ['assigned', 'picking_up', 'picked_up', 'delivering'] } },
      { $set: { status: 'pending', assignedRobot: null, assignedAt: null, pickedUpAt: null } }
    );
  });

  it('still loads the warehouse when the recovery bookkeeping itself fails', async () => {
    // Recovery is bookkeeping; it must never be the reason a warehouse
    // cannot be simulated at all.
    Order.updateMany.mockRejectedValue(new Error('mongo is down'));
    Robot.find.mockResolvedValue([robotDoc('r1', { x: 1, y: 1 }, { status: 'moving' })]);

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    expect(engine.getRobot('r1').status).toBe('idle');
  });

  it('is deterministic: the same persisted state always loads the same way', async () => {
    // Two robots saved on the same cell - only one can be placed, and
    // which one must not depend on Mongo result ordering.
    const docs = [robotDoc('bbb', { x: 5, y: 5 }), robotDoc('aaa', { x: 5, y: 5 })];

    Robot.find.mockResolvedValue(docs);
    const first = (await simulationManager.getEngine(WAREHOUSE_ID)).getAllRobots().map((r) => r.id);

    simulationManager.invalidate(WAREHOUSE_ID);
    Robot.find.mockResolvedValue([...docs].reverse());
    const second = (await simulationManager.getEngine(WAREHOUSE_ID)).getAllRobots().map((r) => r.id);

    expect(first).toEqual(['aaa']);
    expect(second).toEqual(first);
  });
});

describe('engine reload after a layout change', () => {
  it('rebuilds from Mongo and requeues whatever the old runtime state was driving', async () => {
    Robot.find.mockResolvedValue([robotDoc('r1', { x: 0, y: 0 })]);
    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    engine.addObstacle({ id: 'ob1', type: 'human_worker', cells: [{ x: 1, y: 1 }] });

    simulationManager.invalidate(WAREHOUSE_ID);
    Order.updateMany.mockClear();
    const reloaded = await simulationManager.getEngine(WAREHOUSE_ID);

    expect(reloaded).not.toBe(engine);
    expect(reloaded.getObstacles()).toHaveLength(0); // obstacles are runtime-only
    expect(Order.updateMany).toHaveBeenCalled(); // in-flight orders released
  });
});

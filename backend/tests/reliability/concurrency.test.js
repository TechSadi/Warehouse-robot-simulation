/**
 * Concurrency tests for the per-warehouse serialized execution model.
 *
 * Every operation under test here is `async` with at least one `await`
 * between reading simulation state and writing it back. Node is
 * single-threaded, but an `await` is a yield point, so before the
 * warehouse lock (src/services/warehouseLock.js) two of these arriving
 * close together interleaved freely - each one assuming it was the only
 * writer. These tests assert the property that fixes it, rather than a
 * symptom of it: for one warehouse, no two operations are ever in flight
 * at the same time.
 */
const WAREHOUSE_ID = '507f1f77bcf86cd799439022';
const OTHER_WAREHOUSE_ID = '507f1f77bcf86cd799439033';

jest.mock('../../src/models/Warehouse', () => ({ findById: jest.fn() }));
jest.mock('../../src/models/Robot', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  bulkWrite: jest.fn(),
}));
jest.mock('../../src/models/Order', () => ({
  find: jest.fn(),
  insertMany: jest.fn(),
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

/** Mongoose queries are chainable and thenable; this fakes just enough. */
function mockQuery(value) {
  const query = {
    select: jest.fn(() => query),
    sort: jest.fn(() => query),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    catch: (reject) => Promise.resolve(value).catch(reject),
  };
  return query;
}

function openWarehouse(overrides = {}) {
  return { _id: WAREHOUSE_ID, rows: 20, cols: 20, cells: [], schedulingStrategy: 'nearest_robot', ...overrides };
}

function robotDoc(id, position = { x: 0, y: 0 }, overrides = {}) {
  return { _id: id, name: id, position, speed: 1, battery: 100, status: 'idle', ...overrides };
}

/** Records when each critical section is entered and left, so a test can
 * assert they never overlap. An interleaving shows up as two consecutive
 * `enter` entries with no `exit` between them. */
function makeSectionRecorder() {
  const events = [];
  return {
    events,
    /** Wraps an async body in enter/exit markers, with a real macrotask
     * yield inside so an unserialized caller *would* interleave. */
    async section(label, body = async () => {}) {
      events.push(`enter:${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await body();
      events.push(`exit:${label}`);
      return result;
    },
    /** True if every enter is immediately followed by its own exit. */
    isSerialized() {
      for (let i = 0; i < events.length; i += 2) {
        const [kindA, labelA] = events[i].split(':');
        const [kindB, labelB] = (events[i + 1] || '').split(':');
        if (kindA !== 'enter' || kindB !== 'exit' || labelA !== labelB) return false;
      }
      return true;
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  warehouseLock._reset();
  simulationManager.invalidate(WAREHOUSE_ID);
  simulationManager.invalidate(OTHER_WAREHOUSE_ID);
  tickRunner.forgetWarehouse(WAREHOUSE_ID);

  Warehouse.findById.mockReturnValue(mockQuery(openWarehouse()));
  Robot.find.mockResolvedValue([robotDoc('r1', { x: 0, y: 0 })]);
  Robot.bulkWrite.mockResolvedValue({});
  Robot.findByIdAndUpdate.mockResolvedValue({});
  Order.find.mockResolvedValue([]);
  Order.updateMany.mockResolvedValue({ modifiedCount: 0 });
  Order.bulkWrite.mockResolvedValue({});
  Log.create.mockResolvedValue({});
});

describe('warehouseLock', () => {
  it('runs operations on one warehouse strictly one at a time', async () => {
    const recorder = makeSectionRecorder();

    await Promise.all([
      warehouseLock.runExclusive(WAREHOUSE_ID, () => recorder.section('a')),
      warehouseLock.runExclusive(WAREHOUSE_ID, () => recorder.section('b')),
      warehouseLock.runExclusive(WAREHOUSE_ID, () => recorder.section('c')),
    ]);

    expect(recorder.isSerialized()).toBe(true);
    expect(recorder.events).toEqual(['enter:a', 'exit:a', 'enter:b', 'exit:b', 'enter:c', 'exit:c']);
  });

  it('lets different warehouses run concurrently - the lock is per warehouse, not global', async () => {
    const order = [];
    await Promise.all([
      warehouseLock.runExclusive(WAREHOUSE_ID, async () => {
        order.push('a-start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('a-end');
      }),
      warehouseLock.runExclusive(OTHER_WAREHOUSE_ID, async () => {
        order.push('b');
      }),
    ]);

    // B ran while A was still awaiting - two independent warehouses must
    // not queue behind each other.
    expect(order).toEqual(['a-start', 'b', 'a-end']);
  });

  it('releases the lock when an operation throws, instead of wedging the warehouse', async () => {
    await expect(
      warehouseLock.runExclusive(WAREHOUSE_ID, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    await expect(warehouseLock.runExclusive(WAREHOUSE_ID, async () => 'next ran')).resolves.toBe('next ran');
    expect(warehouseLock.isBusy(WAREHOUSE_ID)).toBe(false);
  });

  it('rejects rather than queueing without bound once the backlog is deep', async () => {
    // A backlog this deep means work is arriving faster than the
    // simulation can absorb it; queueing it anyway converts a burst of
    // requests into unbounded memory growth and ever-staler responses.
    const release = [];
    const blocked = warehouseLock.runExclusive(
      WAREHOUSE_ID,
      () => new Promise((resolve) => release.push(resolve))
    );

    const queued = [];
    for (let i = 0; i < warehouseLock.MAX_QUEUE_DEPTH - 1; i += 1) {
      queued.push(warehouseLock.runExclusive(WAREHOUSE_ID, async () => i));
    }

    await expect(warehouseLock.runExclusive(WAREHOUSE_ID, async () => 'overflow')).rejects.toMatchObject({
      code: 'WAREHOUSE_BUSY',
      statusCode: 503,
    });

    release.forEach((resolve) => resolve());
    await Promise.all([blocked, ...queued]);
  });

  it('forgets a warehouse chain once it is idle, so entries do not accumulate', async () => {
    await warehouseLock.runExclusive(WAREHOUSE_ID, async () => 'done');
    expect(warehouseLock.queueDepth(WAREHOUSE_ID)).toBe(0);
    expect(warehouseLock.isBusy(WAREHOUSE_ID)).toBe(false);
  });
});

describe('concurrent ticks', () => {
  it('never interleaves two ticks on the same warehouse', async () => {
    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    engine.assignTask('r1', { x: 8, y: 0 }); // so every tick really does persist something

    const recorder = makeSectionRecorder();
    let n = 0;
    // The persist step is the middle of the tick's critical section - if
    // two ticks overlap at all, they overlap here.
    Robot.bulkWrite.mockImplementation(() => recorder.section(`tick${(n += 1)}`));

    const [first, second] = await Promise.all([
      tickRunner.runTick(WAREHOUSE_ID, 1),
      tickRunner.runTick(WAREHOUSE_ID, 1),
    ]);

    expect(first.changed).toHaveLength(1);
    expect(second.changed).toHaveLength(1);
    expect(recorder.events).toEqual(['enter:tick1', 'exit:tick1', 'enter:tick2', 'exit:tick2']);
    expect(recorder.isSerialized()).toBe(true);
  });

  it('advances the simulation exactly once per tick, whatever the arrival pattern', async () => {
    // Deterministic outcome check: a robot at (0,0) with speed 1 moving to
    // (5,0) has travelled exactly 3 cells after three 1-second ticks -
    // never 6 because two ticks overlapped, and never 2 because one was
    // lost.
    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    engine.assignTask('r1', { x: 5, y: 0 });

    await Promise.all([
      tickRunner.runTick(WAREHOUSE_ID, 1),
      tickRunner.runTick(WAREHOUSE_ID, 1),
      tickRunner.runTick(WAREHOUSE_ID, 1),
    ]);

    expect(engine.getRobot('r1').position).toEqual({ x: 3, y: 0 });
  });

  it('drops an automatic tick that arrives while one is already running', async () => {
    // Queueing automatic ticks would let a slow tick build a backlog that
    // then replays as a burst of catch-up ticks; dropping is the honest
    // outcome - that interval simply produced no motion.
    await simulationManager.getEngine(WAREHOUSE_ID); // warm the cache so the tick is the only slow part

    // Every tick ends by dispatching, which reads the pending orders -
    // holding that read open holds the whole tick open.
    let releaseFirst;
    const pendingRead = new Promise((resolve) => { releaseFirst = () => resolve([]); });
    Order.find.mockReturnValueOnce(pendingRead);

    const first = tickRunner.runAutoTick(WAREHOUSE_ID, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await tickRunner.runAutoTick(WAREHOUSE_ID, 1);

    expect(second).toEqual({ skipped: true });

    releaseFirst();
    expect(await first).toEqual({ skipped: false, value: expect.any(Object) });
  });

  it('applies a manual tick between automatic ticks, never on top of one', async () => {
    const recorder = makeSectionRecorder();
    let n = 0;
    Robot.bulkWrite.mockImplementation(() => recorder.section(`t${(n += 1)}`));

    await Promise.all([
      tickRunner.runTick(WAREHOUSE_ID, 0.5), // the manual REST tick
      tickRunner.runTick(WAREHOUSE_ID, 0.5), // the automatic loop's tick
    ]);

    expect(recorder.isSerialized()).toBe(true);
  });
});

describe('dispatch during a tick', () => {
  it('does not interleave a dispatch with the tick that is running', async () => {
    const recorder = makeSectionRecorder();
    let n = 0;
    Robot.bulkWrite.mockImplementation(() => recorder.section(`write${(n += 1)}`));
    Order.find.mockResolvedValue([
      {
        _id: 'o1',
        priority: 'normal',
        createdAt: new Date(),
        pickupLocation: { x: 2, y: 0 },
        deliveryLocation: { x: 4, y: 0 },
      },
    ]);

    await Promise.all([
      tickRunner.runTick(WAREHOUSE_ID, 1),
      orderService.dispatchPendingOrders(WAREHOUSE_ID),
    ]);

    expect(recorder.isSerialized()).toBe(true);
  });

  it('never assigns the same order twice when two dispatches race', async () => {
    Order.find.mockResolvedValue([
      {
        _id: 'o1',
        priority: 'normal',
        createdAt: new Date(),
        pickupLocation: { x: 2, y: 0 },
        deliveryLocation: { x: 4, y: 0 },
      },
    ]);

    const [a, b] = await Promise.all([
      orderService.dispatchPendingOrders(WAREHOUSE_ID),
      orderService.dispatchPendingOrders(WAREHOUSE_ID),
    ]);

    // The second dispatch sees the robot already carrying the order (the
    // coordinator refuses to double-book it), so exactly one assignment is
    // made across both calls.
    expect([...a, ...b]).toHaveLength(1);
  });
});

describe('obstacle changes during a simulation', () => {
  it('serializes an obstacle change against a running tick', async () => {
    const recorder = makeSectionRecorder();
    Robot.bulkWrite.mockImplementation(() => recorder.section('tick'));

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);

    await Promise.all([
      tickRunner.runTick(WAREHOUSE_ID, 1),
      // Exactly what warehouse.controller.js does for POST /obstacles.
      warehouseLock.runExclusive(WAREHOUSE_ID, () =>
        recorder.section('obstacle', async () =>
          engine.addObstacle({ id: 'ob1', type: 'human_worker', cells: [{ x: 3, y: 3 }] })
        )
      ),
    ]);

    expect(recorder.isSerialized()).toBe(true);
    expect(engine.getObstacles()).toHaveLength(1);
  });

  it('an obstacle added mid-simulation reroutes a robot already under way', async () => {
    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    engine.assignTask('r1', { x: 4, y: 0 });
    await tickRunner.runTick(WAREHOUSE_ID, 1); // now at (1,0), heading east

    engine.addObstacle({ id: 'wall', type: 'construction_zone', cells: [{ x: 2, y: 0 }] });
    await tickRunner.runTick(WAREHOUSE_ID, 1);

    // It must not have walked into the blocked cell.
    expect(engine.getRobot('r1').position).not.toEqual({ x: 2, y: 0 });
    expect(engine.getRobot('r1').status).toBe('moving');
  });
});

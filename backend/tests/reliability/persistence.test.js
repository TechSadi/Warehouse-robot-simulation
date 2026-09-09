/**
 * What survives a restart, and what the cache is allowed to hold.
 *
 * Three of the documented limitations met here: in-flight work was not
 * resumed across a restart, dynamic obstacles were not persisted at all,
 * and the engine cache was unbounded in the number of warehouses ever
 * touched. The fourth - recovery running as a side effect of a plain read -
 * is covered by `peekEngine` never building an engine.
 */
jest.mock('../../src/models/Warehouse', () => ({
  findById: jest.fn(),
  updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
}));
jest.mock('../../src/models/Robot', () => ({
  find: jest.fn(),
  bulkWrite: jest.fn().mockResolvedValue({}),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../src/models/Order', () => ({
  updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
}));

const Warehouse = require('../../src/models/Warehouse');
const Robot = require('../../src/models/Robot');
const simulationManager = require('../../src/services/simulationManager');
const { STATUSES } = require('../../src/engine/robots/robotEngine');

const WAREHOUSE_ID = '507f1f77bcf86cd799439022';

function warehouseDoc(overrides = {}) {
  return {
    _id: WAREHOUSE_ID,
    rows: 20,
    cols: 20,
    cells: [],
    dynamicObstacles: [],
    ...overrides,
  };
}

function robotDoc(id, position, overrides = {}) {
  return {
    _id: id,
    name: id,
    position,
    speed: 2,
    battery: 100,
    status: 'idle',
    errorReason: null,
    currentTask: null,
    taskQueue: [],
    ...overrides,
  };
}

/** `Warehouse.findById(...)` is chained with `.select(...)` on some paths
 * and awaited directly on others, so the stub has to support both. */
function resolveWarehouse(doc) {
  Warehouse.findById.mockImplementation(() => {
    const promise = Promise.resolve(doc);
    // @ts-ignore - a thenable that also answers .select(), like a Query
    promise.select = () => Promise.resolve(doc);
    return promise;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  simulationManager.engines.clear();
  simulationManager.orderCoordinators.clear();
  simulationManager.schedulerStates.clear();
  simulationManager.lastUsedAt.clear();
  simulationManager.pinned.clear();
  simulationManager.maxCachedEngines = 64;
  simulationManager.engineIdleTtlMs = 30 * 60 * 1000;
  Warehouse.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Robot.bulkWrite.mockResolvedValue({});
});

describe('resuming in-flight work across a restart', () => {
  it('puts a robot back on the destination it was driving to', async () => {
    resolveWarehouse(warehouseDoc());
    Robot.find.mockResolvedValue([
      robotDoc('r1', { x: 2, y: 2 }, {
        status: 'moving',
        currentTask: { x: 8, y: 8 },
        taskQueue: [{ x: 9, y: 9 }],
      }),
    ]);

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    const robot = engine.getRobot('r1');

    expect(robot.status).toBe(STATUSES.MOVING);
    expect(robot.currentTask).toEqual({ x: 8, y: 8 });
    expect(robot.taskQueue).toEqual([{ x: 9, y: 9 }]);
  });

  it('replans from where the robot actually came back, not from its old path', async () => {
    // Persisted mid-move, so Mongo holds a fractional position. The robot
    // comes back in the cell it was nearest and plans from there.
    resolveWarehouse(warehouseDoc());
    Robot.find.mockResolvedValue([
      robotDoc('r1', { x: 3.4, y: 2 }, { status: 'moving', currentTask: { x: 8, y: 2 } }),
    ]);

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    expect(engine.getRobot('r1').position).toEqual({ x: 3, y: 2 });
    expect(engine.getRobot('r1').status).toBe(STATUSES.MOVING);
  });

  it('writes the resumed state back, so Mongo is not left a queue ahead of the engine', async () => {
    resolveWarehouse(warehouseDoc());
    Robot.find.mockResolvedValue([
      robotDoc('r1', { x: 2, y: 2 }, { status: 'moving', taskQueue: [{ x: 8, y: 8 }] }),
    ]);

    await simulationManager.getEngine(WAREHOUSE_ID);

    expect(Robot.bulkWrite).toHaveBeenCalled();
    const [ops] = Robot.bulkWrite.mock.calls[0];
    expect(ops[0].updateOne.update).toMatchObject({
      currentTask: { x: 8, y: 8 }, // consumed from the queue into the current trip
      taskQueue: [],
    });
  });

  it('leaves an idle robot with nothing queued completely alone', async () => {
    resolveWarehouse(warehouseDoc());
    Robot.find.mockResolvedValue([robotDoc('r1', { x: 2, y: 2 })]);

    await simulationManager.getEngine(WAREHOUSE_ID);
    expect(Robot.bulkWrite).not.toHaveBeenCalled();
  });
});

describe('dynamic obstacles surviving a restart', () => {
  it('restores stored hazards into the engine', async () => {
    resolveWarehouse(
      warehouseDoc({
        dynamicObstacles: [
          { id: 'zone1', type: 'construction_zone', cells: [{ x: 4, y: 4 }], remainingSeconds: null },
          { id: 'w1', type: 'human_worker', cells: [{ x: 6, y: 6 }], remainingSeconds: 30 },
        ],
      })
    );
    Robot.find.mockResolvedValue([]);

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    expect(engine.getObstacles()).toEqual([
      { id: 'zone1', type: 'construction_zone', cells: [{ x: 4, y: 4 }], remainingSeconds: null },
      { id: 'w1', type: 'human_worker', cells: [{ x: 6, y: 6 }], remainingSeconds: 30 },
    ]);
  });

  it('judges a robot\'s saved cell against the hazards, not against an emptier world', async () => {
    // The robot was parked where a construction zone now stands. It must
    // not silently load *underneath* one.
    resolveWarehouse(
      warehouseDoc({
        dynamicObstacles: [
          { id: 'zone1', type: 'construction_zone', cells: [{ x: 2, y: 2 }], remainingSeconds: null },
        ],
      })
    );
    Robot.find.mockResolvedValue([robotDoc('r1', { x: 2, y: 2 })]);

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    expect(engine.getRobot('r1')).toBeNull();
    // ...and Mongo is told, rather than continuing to advertise a healthy
    // robot the simulation cannot see.
    const [ops] = Robot.bulkWrite.mock.calls[0];
    expect(ops[0].updateOne.update.status).toBe('error');
  });

  it('drops an expired hazard rather than resurrecting it', async () => {
    resolveWarehouse(
      warehouseDoc({
        dynamicObstacles: [
          { id: 'gone', type: 'human_worker', cells: [{ x: 1, y: 1 }], remainingSeconds: 0 },
        ],
      })
    );
    Robot.find.mockResolvedValue([]);

    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    expect(engine.getObstacles()).toEqual([]);
  });

  it('writes the whole set back through persistObstacles', async () => {
    const engine = {
      getObstacles: () => [
        { id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 1 }], remainingSeconds: 12 },
      ],
    };
    await simulationManager.persistObstacles(WAREHOUSE_ID, engine);

    expect(Warehouse.updateOne).toHaveBeenCalledWith(
      { _id: WAREHOUSE_ID },
      {
        $set: {
          dynamicObstacles: [
            { id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 1 }], remainingSeconds: 12 },
          ],
        },
      }
    );
  });

  it('degrades rather than failing the request when the write fails', async () => {
    // The hazard is already in the live simulation by this point; failing
    // the request that created it would be worse than losing its backup.
    Warehouse.updateOne.mockRejectedValue(new Error('mongo is unhappy'));
    const engine = { getObstacles: () => [] };
    await expect(simulationManager.persistObstacles(WAREHOUSE_ID, engine)).resolves.toBeUndefined();
  });
});

describe('reading without reconciling', () => {
  it('peekEngine never builds one', async () => {
    resolveWarehouse(warehouseDoc());
    Robot.find.mockResolvedValue([]);

    expect(await simulationManager.peekEngine(WAREHOUSE_ID)).toBeNull();
    expect(Warehouse.findById).not.toHaveBeenCalled();
    expect(Robot.find).not.toHaveBeenCalled();
  });

  it('readObstacles answers from the warehouse document when nothing is loaded', async () => {
    resolveWarehouse(
      warehouseDoc({
        dynamicObstacles: [
          { id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 1 }], remainingSeconds: null },
        ],
      })
    );

    const obstacles = await simulationManager.readObstacles(WAREHOUSE_ID);

    expect(obstacles).toEqual([
      { id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 1 }], remainingSeconds: null },
    ]);
    // The tell that no engine was built: the fleet was never read, and so
    // no reconciliation write could have happened.
    expect(Robot.find).not.toHaveBeenCalled();
    expect(Robot.bulkWrite).not.toHaveBeenCalled();
  });

  it('readObstacles prefers the live set when an engine is loaded', async () => {
    resolveWarehouse(warehouseDoc({ dynamicObstacles: [] }));
    Robot.find.mockResolvedValue([]);
    const engine = await simulationManager.getEngine(WAREHOUSE_ID);
    engine.addObstacle({ id: 'live', type: 'human_worker', cells: [{ x: 2, y: 2 }] });

    const obstacles = await simulationManager.readObstacles(WAREHOUSE_ID);
    expect(obstacles.map((o) => o.id)).toEqual(['live']);
  });

  it('readObstacles reports a missing warehouse as null', async () => {
    resolveWarehouse(null);
    expect(await simulationManager.readObstacles(WAREHOUSE_ID)).toBeNull();
  });
});

describe('bounding the engine cache', () => {
  async function loadWarehouse(id) {
    Warehouse.findById.mockImplementation(() => {
      const doc = warehouseDoc({ _id: id });
      const promise = Promise.resolve(doc);
      // @ts-ignore
      promise.select = () => Promise.resolve(doc);
      return promise;
    });
    Robot.find.mockResolvedValue([]);
    return simulationManager.getEngine(id);
  }

  it('evicts the least recently used engine once over the ceiling', async () => {
    simulationManager.maxCachedEngines = 2;

    await loadWarehouse('w1');
    await loadWarehouse('w2');
    await simulationManager.getEngine('w1'); // w1 is now the more recent of the two
    await loadWarehouse('w3');

    expect(simulationManager.hasEngine('w2')).toBe(false);
    expect(simulationManager.hasEngine('w1')).toBe(true);
    expect(simulationManager.hasEngine('w3')).toBe(true);
  });

  it('never evicts a warehouse that is actively ticking', async () => {
    // Evicting a running warehouse would reload it a moment later and
    // requeue every in-flight order it was working.
    simulationManager.maxCachedEngines = 1;

    await loadWarehouse('w1');
    simulationManager.pin('w1');
    await loadWarehouse('w2');

    expect(simulationManager.hasEngine('w1')).toBe(true);

    simulationManager.unpin('w1');
    await loadWarehouse('w3');
    expect(simulationManager.hasEngine('w1')).toBe(false);
  });

  it('evicts an engine nobody has used for longer than the idle TTL', async () => {
    simulationManager.engineIdleTtlMs = 1000;

    await loadWarehouse('w1');
    simulationManager.lastUsedAt.set('w1', Date.now() - 5000);
    await loadWarehouse('w2');

    expect(simulationManager.hasEngine('w1')).toBe(false);
  });

  it('leaves the cache alone when both limits are disabled', async () => {
    simulationManager.maxCachedEngines = 0;
    simulationManager.engineIdleTtlMs = 0;

    await loadWarehouse('w1');
    simulationManager.lastUsedAt.set('w1', 0);
    await loadWarehouse('w2');

    expect(simulationManager.hasEngine('w1')).toBe(true);
  });
});

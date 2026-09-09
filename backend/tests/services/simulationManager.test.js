jest.mock('../../src/models/Robot', () => ({
  find: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  bulkWrite: jest.fn(),
}));

const Robot = require('../../src/models/Robot');
const simulationManager = require('../../src/services/simulationManager');

beforeEach(() => {
  jest.clearAllMocks();
  Robot.bulkWrite.mockResolvedValue({});
  Robot.findByIdAndUpdate.mockResolvedValue({});
});

describe('persistRobots (Milestone 14)', () => {
  it('writes every snapshot in a single bulkWrite call', async () => {
    const snapshots = [
      {
        id: 'r1',
        position: { x: 1, y: 2 },
        rotation: 90,
        battery: 80,
        status: 'moving',
        errorReason: null,
        currentTask: { x: 6, y: 6 },
        taskQueue: [{ x: 7, y: 7 }],
      },
      {
        id: 'r2',
        position: { x: 3, y: 4 },
        rotation: 0,
        battery: 55,
        status: 'idle',
        errorReason: null,
        currentTask: null,
        taskQueue: [],
      },
    ];

    await simulationManager.persistRobots(snapshots);

    expect(Robot.bulkWrite).toHaveBeenCalledTimes(1);
    const [ops, options] = Robot.bulkWrite.mock.calls[0];
    // The robot's *work* is persisted alongside its physical state: the
    // destination it is driving to and the ones queued behind it. That is
    // what lets a restart resume the route rather than dropping it and
    // releasing every in-flight order back to `pending`.
    expect(ops).toEqual([
      {
        updateOne: {
          filter: { _id: 'r1' },
          update: {
            position: { x: 1, y: 2 },
            rotation: 90,
            battery: 80,
            status: 'moving',
            errorReason: null,
            currentTask: { x: 6, y: 6 },
            taskQueue: [{ x: 7, y: 7 }],
          },
        },
      },
      {
        updateOne: {
          filter: { _id: 'r2' },
          update: {
            position: { x: 3, y: 4 },
            rotation: 0,
            battery: 55,
            status: 'idle',
            errorReason: null,
            currentTask: null,
            taskQueue: [],
          },
        },
      },
    ]);
    expect(options).toEqual({ ordered: false });
  });

  it('does nothing (no Mongo call at all) for an empty list', async () => {
    await simulationManager.persistRobots([]);
    expect(Robot.bulkWrite).not.toHaveBeenCalled();
  });

  it('does nothing for undefined/null input rather than throwing', async () => {
    await expect(simulationManager.persistRobots(undefined)).resolves.toBeUndefined();
    await expect(simulationManager.persistRobots(null)).resolves.toBeUndefined();
    expect(Robot.bulkWrite).not.toHaveBeenCalled();
  });

  it('does not touch findByIdAndUpdate - that remains persistRobot (singular) only', async () => {
    await simulationManager.persistRobots([{ id: 'r1', position: { x: 0, y: 0 } }]);
    expect(Robot.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});

describe('persistRobot (singular, unchanged)', () => {
  it('still updates one robot via findByIdAndUpdate', async () => {
    const snapshot = {
      position: { x: 5, y: 5 },
      rotation: 45,
      battery: 90,
      status: 'idle',
      errorReason: null,
      currentTask: null,
      taskQueue: [{ x: 2, y: 3 }],
    };
    await simulationManager.persistRobot('r1', snapshot);
    // Same field set as the bulk path - one builder feeds both, so the two
    // cannot drift into persisting different subsets of the same state.
    expect(Robot.findByIdAndUpdate).toHaveBeenCalledWith('r1', {
      position: { x: 5, y: 5 },
      rotation: 45,
      battery: 90,
      status: 'idle',
      errorReason: null,
      currentTask: null,
      taskQueue: [{ x: 2, y: 3 }],
    });
    expect(Robot.bulkWrite).not.toHaveBeenCalled();
  });
});

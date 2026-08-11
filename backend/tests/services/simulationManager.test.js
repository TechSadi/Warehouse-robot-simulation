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
      { id: 'r1', position: { x: 1, y: 2 }, rotation: 90, battery: 80, status: 'moving', errorReason: null },
      { id: 'r2', position: { x: 3, y: 4 }, rotation: 0, battery: 55, status: 'idle', errorReason: null },
    ];

    await simulationManager.persistRobots(snapshots);

    expect(Robot.bulkWrite).toHaveBeenCalledTimes(1);
    const [ops, options] = Robot.bulkWrite.mock.calls[0];
    expect(ops).toEqual([
      {
        updateOne: {
          filter: { _id: 'r1' },
          update: { position: { x: 1, y: 2 }, rotation: 90, battery: 80, status: 'moving', errorReason: null },
        },
      },
      {
        updateOne: {
          filter: { _id: 'r2' },
          update: { position: { x: 3, y: 4 }, rotation: 0, battery: 55, status: 'idle', errorReason: null },
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
    const snapshot = { position: { x: 5, y: 5 }, rotation: 45, battery: 90, status: 'idle', errorReason: null };
    await simulationManager.persistRobot('r1', snapshot);
    expect(Robot.findByIdAndUpdate).toHaveBeenCalledWith('r1', snapshot);
    expect(Robot.bulkWrite).not.toHaveBeenCalled();
  });
});

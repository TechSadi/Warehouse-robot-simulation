jest.mock('../../src/services/tickRunner', () => ({
  runTick: jest.fn().mockResolvedValue(null),
}));

const { runTick } = require('../../src/services/tickRunner');
const { TickLoopManager, room } = require('../../src/sockets/tickLoopManager');

const WAREHOUSE_ID = '507f1f77bcf86cd799439022';

/** A minimal fake of the bits of a Socket.IO `io` instance tickLoopManager
 * touches: `.to(room).emit(event, payload)` and
 * `.sockets.adapter.rooms.get(room)` (a Set-like occupant count). */
function fakeIo(occupantsByRoom = {}) {
  const emitted = [];
  const roomsMap = new Map(Object.entries(occupantsByRoom).map(([r, count]) => [r, { size: count }]));
  return {
    emitted,
    to: (roomName) => ({
      emit: (event, payload) => emitted.push({ room: roomName, event, payload }),
    }),
    sockets: { adapter: { rooms: roomsMap } },
    setOccupants(roomName, count) {
      roomsMap.set(roomName, { size: count });
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('TickLoopManager.start', () => {
  it('calls runTick repeatedly at the configured interval', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    manager.start(io, WAREHOUSE_ID, 0.1);
    expect(runTick).not.toHaveBeenCalled(); // nothing until the first interval elapses

    jest.advanceTimersByTime(100);
    expect(runTick).toHaveBeenCalledTimes(1);
    expect(runTick).toHaveBeenCalledWith(WAREHOUSE_ID, 0.1);

    jest.advanceTimersByTime(300);
    expect(runTick).toHaveBeenCalledTimes(4);
  });

  it('defaults deltaSeconds from the interval when none is given', () => {
    const manager = new TickLoopManager(200);
    const io = fakeIo();

    manager.start(io, WAREHOUSE_ID);
    jest.advanceTimersByTime(200);

    expect(runTick).toHaveBeenCalledWith(WAREHOUSE_ID, 0.2);
  });

  it('broadcasts simulation:status running:true to the warehouse room', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    manager.start(io, WAREHOUSE_ID, 0.1);

    expect(io.emitted).toContainEqual({
      room: room(WAREHOUSE_ID),
      event: 'simulation:status',
      payload: { warehouseId: WAREHOUSE_ID, running: true },
    });
  });

  it('starting an already-running warehouse is a no-op (one interval, not two)', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    manager.start(io, WAREHOUSE_ID, 0.1);
    manager.start(io, WAREHOUSE_ID, 0.1); // second call should not create a second interval
    manager.stop(io, WAREHOUSE_ID); // a single stop should be enough to fully stop it

    jest.advanceTimersByTime(500);
    expect(runTick).not.toHaveBeenCalled();
  });

  it('tracks isRunning correctly', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    expect(manager.isRunning(WAREHOUSE_ID)).toBe(false);
    manager.start(io, WAREHOUSE_ID, 0.1);
    expect(manager.isRunning(WAREHOUSE_ID)).toBe(true);
    manager.stop(io, WAREHOUSE_ID);
    expect(manager.isRunning(WAREHOUSE_ID)).toBe(false);
  });
});

describe('TickLoopManager.stop', () => {
  it('clears the interval so no further ticks happen', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    manager.start(io, WAREHOUSE_ID, 0.1);
    jest.advanceTimersByTime(100);
    expect(runTick).toHaveBeenCalledTimes(1);

    manager.stop(io, WAREHOUSE_ID);
    jest.advanceTimersByTime(500);
    expect(runTick).toHaveBeenCalledTimes(1); // unchanged - no more ticks after stop
  });

  it('broadcasts simulation:status running:false', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    manager.start(io, WAREHOUSE_ID, 0.1);
    manager.stop(io, WAREHOUSE_ID);

    expect(io.emitted).toContainEqual({
      room: room(WAREHOUSE_ID),
      event: 'simulation:status',
      payload: { warehouseId: WAREHOUSE_ID, running: false },
    });
  });

  it('stopping a warehouse that was never started is a harmless no-op', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    expect(() => manager.stop(io, WAREHOUSE_ID)).not.toThrow();
    expect(io.emitted).toHaveLength(0);
  });
});

describe('TickLoopManager.stopIfIdle', () => {
  it('stops the loop when the room has no occupants', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo({ [room(WAREHOUSE_ID)]: 0 });

    manager.start(io, WAREHOUSE_ID, 0.1);
    manager.stopIfIdle(io, WAREHOUSE_ID);

    jest.advanceTimersByTime(500);
    expect(runTick).not.toHaveBeenCalled();
    expect(manager.isRunning(WAREHOUSE_ID)).toBe(false);
  });

  it('leaves the loop running when the room still has occupants', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo({ [room(WAREHOUSE_ID)]: 2 });

    manager.start(io, WAREHOUSE_ID, 0.1);
    manager.stopIfIdle(io, WAREHOUSE_ID);

    jest.advanceTimersByTime(100);
    expect(runTick).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when nothing is running for that warehouse', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo({ [room(WAREHOUSE_ID)]: 0 });

    expect(() => manager.stopIfIdle(io, WAREHOUSE_ID)).not.toThrow();
    expect(io.emitted).toHaveLength(0);
  });
});

describe('TickLoopManager.stopAll', () => {
  it('clears every warehouse\'s interval', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    manager.start(io, 'w1', 0.1);
    manager.start(io, 'w2', 0.1);
    manager.stopAll();

    jest.advanceTimersByTime(500);
    expect(runTick).not.toHaveBeenCalled();
    expect(manager.isRunning('w1')).toBe(false);
    expect(manager.isRunning('w2')).toBe(false);
  });
});

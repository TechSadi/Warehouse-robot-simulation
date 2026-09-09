// The loop calls `runAutoTick`, not `runAutoTick`: an automatic tick that
// arrives while the previous one is still running is dropped rather than
// queued behind it (see services/warehouseLock.js).
jest.mock('../../src/services/tickRunner', () => ({
  runAutoTick: jest.fn().mockResolvedValue({ skipped: false, value: null }),
}));

const { runAutoTick } = require('../../src/services/tickRunner');
const { TickLoopManager, room } = require('../../src/sockets/tickLoopManager');
const env = require('../../src/config/env');

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

/**
 * Advances fake timers *and* drains the microtasks the interval callback
 * queues behind them.
 *
 * A tick is no longer synchronous with its interval firing: before
 * advancing the world the loop confirms this process still holds the
 * warehouse's lease (services/instanceLease.js), which is an `await` even
 * when leasing is inactive, as it is under test. `advanceTimersByTime`
 * alone therefore returns before `runAutoTick` has been reached.
 */
async function advance(ms) {
  await jest.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  jest.clearAllMocks();
  runAutoTick.mockResolvedValue({ skipped: false, value: null });
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('TickLoopManager.start', () => {
  it('calls runAutoTick repeatedly at the configured interval', async () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    manager.start(io, WAREHOUSE_ID, 0.1);
    expect(runAutoTick).not.toHaveBeenCalled(); // nothing until the first interval elapses

    await advance(100);
    expect(runAutoTick).toHaveBeenCalledTimes(1);
    // The step is *measured* elapsed time, not the nominal delta - which
    // here is the same 0.1s, because nothing delayed the interval.
    expect(runAutoTick).toHaveBeenCalledWith(WAREHOUSE_ID, 0.1);

    await advance(300);
    expect(runAutoTick).toHaveBeenCalledTimes(4);
  });

  it('advances by measured elapsed time, capped, rather than by the nominal delta', async () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();
    // One tick that takes far longer than its interval. Every interval
    // that fires while it is running is dropped rather than queued (see
    // warehouseLock.tryRunExclusive) - what must not happen is that the
    // time those intervals covered vanishes from the simulation's clock.
    runAutoTick.mockResolvedValue({ skipped: true });

    manager.start(io, WAREHOUSE_ID, 0.1);
    await advance(100);
    await advance(400); // four more intervals, all skipped

    runAutoTick.mockResolvedValue({ skipped: false, value: null });
    await advance(100);

    const [, delta] = runAutoTick.mock.calls[runAutoTick.mock.calls.length - 1];
    // 600ms of wall clock accumulated behind the skips, clamped to the
    // per-tick ceiling so the fleet catches up rather than teleporting.
    expect(delta).toBeGreaterThan(0.1);
    expect(delta).toBeLessThanOrEqual(env.simulation.maxTickDeltaSeconds);
  });

  it('counts skipped ticks and reports how far behind the wall clock it is', async () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();
    runAutoTick.mockResolvedValue({ skipped: true });

    manager.start(io, WAREHOUSE_ID, 0.1);
    await advance(300);

    const status = manager.status(WAREHOUSE_ID);
    expect(status.skippedTicks).toBe(3);
    expect(status.ticks).toBe(0);
    expect(status.simulatedSeconds).toBe(0);
  });

  it('defaults deltaSeconds from the interval when none is given', async () => {
    const manager = new TickLoopManager(200);
    const io = fakeIo();

    manager.start(io, WAREHOUSE_ID);
    expect(manager.status(WAREHOUSE_ID).deltaSeconds).toBe(0.2);

    await advance(200);
    expect(runAutoTick).toHaveBeenCalledWith(WAREHOUSE_ID, 0.2);
  });

  it('broadcasts simulation:status running:true to the warehouse room', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    manager.start(io, WAREHOUSE_ID, 0.1);

    expect(io.emitted).toContainEqual({
      room: room(WAREHOUSE_ID),
      event: 'simulation:status',
      payload: expect.objectContaining({ warehouseId: WAREHOUSE_ID, running: true, deltaSeconds: 0.1 }),
    });
  });

  it('starting an already-running warehouse is a no-op (one interval, not two)', async () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    manager.start(io, WAREHOUSE_ID, 0.1);
    manager.start(io, WAREHOUSE_ID, 0.1); // second call should not create a second interval
    manager.stop(io, WAREHOUSE_ID); // a single stop should be enough to fully stop it

    await advance(500);
    expect(runAutoTick).not.toHaveBeenCalled();
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
  it('clears the interval so no further ticks happen', async () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    manager.start(io, WAREHOUSE_ID, 0.1);
    await advance(100);
    expect(runAutoTick).toHaveBeenCalledTimes(1);

    manager.stop(io, WAREHOUSE_ID);
    await advance(500);
    expect(runAutoTick).toHaveBeenCalledTimes(1); // unchanged - no more ticks after stop
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
  it('stops the loop when the room has no occupants', async () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo({ [room(WAREHOUSE_ID)]: 0 });

    manager.start(io, WAREHOUSE_ID, 0.1);
    manager.stopIfIdle(io, WAREHOUSE_ID);

    await advance(500);
    expect(runAutoTick).not.toHaveBeenCalled();
    expect(manager.isRunning(WAREHOUSE_ID)).toBe(false);
  });

  it('leaves the loop running when the room still has occupants', async () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo({ [room(WAREHOUSE_ID)]: 2 });

    manager.start(io, WAREHOUSE_ID, 0.1);
    manager.stopIfIdle(io, WAREHOUSE_ID);

    await advance(100);
    expect(runAutoTick).toHaveBeenCalledTimes(1);
  });

  it('leaves a background loop running with nobody watching', async () => {
    // A simulation is normally a thing being watched, and stops when the
    // last watcher leaves. `background: true` is the explicit opt-out for
    // when it genuinely is a background job.
    const manager = new TickLoopManager(100);
    const io = fakeIo({ [room(WAREHOUSE_ID)]: 0 });

    manager.start(io, WAREHOUSE_ID, 0.1, { background: true });
    manager.stopIfIdle(io, WAREHOUSE_ID);

    expect(manager.isRunning(WAREHOUSE_ID)).toBe(true);
    await advance(100);
    expect(runAutoTick).toHaveBeenCalledTimes(1);
    expect(manager.status(WAREHOUSE_ID).background).toBe(true);
  });

  it('stops a background loop once it reaches its unattended time limit', async () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo({ [room(WAREHOUSE_ID)]: 0 });

    manager.start(io, WAREHOUSE_ID, 0.1, { background: true });
    await advance(env.simulation.maxBackgroundSeconds * 1000 + 200);

    expect(manager.isRunning(WAREHOUSE_ID)).toBe(false);
  });

  it('is a no-op when nothing is running for that warehouse', () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo({ [room(WAREHOUSE_ID)]: 0 });

    expect(() => manager.stopIfIdle(io, WAREHOUSE_ID)).not.toThrow();
    expect(io.emitted).toHaveLength(0);
  });
});

describe('TickLoopManager.stopAll', () => {
  it('clears every warehouse\'s interval', async () => {
    const manager = new TickLoopManager(100);
    const io = fakeIo();

    manager.start(io, 'w1', 0.1);
    manager.start(io, 'w2', 0.1);
    manager.stopAll();

    await advance(500);
    expect(runAutoTick).not.toHaveBeenCalled();
    expect(manager.isRunning('w1')).toBe(false);
    expect(manager.isRunning('w2')).toBe(false);
  });
});

const http = require('http');
const { io: ioClient } = require('socket.io-client');

process.env.TICK_INTERVAL_MS = '60'; // fast enough to observe a few ticks without a slow test

jest.mock('../../src/services/tickRunner', () => ({
  runTick: jest.fn().mockResolvedValue(null),
}));

const { runTick } = require('../../src/services/tickRunner');
const simulationEvents = require('../../src/events/simulationEvents');
const initSockets = require('../../src/sockets');

const WAREHOUSE_A = '507f1f77bcf86cd799439022';
const WAREHOUSE_B = '507f1f77bcf86cd799439033';

let httpServer;
let io;
let port;

/** Connects a client socket and resolves once it's actually connected. */
function connectClient() {
  return new Promise((resolve, reject) => {
    const client = ioClient(`http://127.0.0.1:${port}`, { path: '/socket.io', forceNew: true });
    client.on('connect', () => resolve(client));
    client.on('connect_error', reject);
  });
}

/** Resolves with the payload of the next occurrence of `event` on `client`. */
function nextEvent(client, event) {
  return new Promise((resolve) => client.once(event, resolve));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll((done) => {
  httpServer = http.createServer();
  io = initSockets(httpServer);
  httpServer.listen(0, () => {
    port = httpServer.address().port;
    done();
  });
});

afterAll((done) => {
  initSockets.tickLoopManager.stopAll();
  delete process.env.TICK_INTERVAL_MS; // process.env is process-global across --runInBand test files
  io.close();
  httpServer.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('connection', () => {
  it('sends a server:welcome message on connect', async () => {
    // Subscribe before the handshake completes, not after awaiting
    // 'connect' first - the server emits server:welcome synchronously from
    // its own 'connection' handler, so listening only after our 'connect'
    // promise resolves is a race that can miss it.
    const client = ioClient(`http://127.0.0.1:${port}`, { path: '/socket.io', forceNew: true });
    const welcome = await nextEvent(client, 'server:welcome');
    expect(welcome.message).toMatch(/warehouse simulation server/i);
    client.disconnect();
  });
});

describe('warehouse rooms', () => {
  it('delivers a robots:changed event only to clients that joined that warehouse', async () => {
    const watcherA = await connectClient();
    const watcherB = await connectClient();
    watcherA.emit('warehouse:join', WAREHOUSE_A);
    watcherB.emit('warehouse:join', WAREHOUSE_B);
    await wait(50); // let the joins land server-side

    const receivedByA = nextEvent(watcherA, 'robots:changed');
    let receivedByB = false;
    watcherB.once('robots:changed', () => {
      receivedByB = true;
    });

    simulationEvents.emit('robots:changed', {
      warehouseId: WAREHOUSE_A,
      robots: [{ id: 'r1', status: 'moving' }],
    });

    const payload = await receivedByA;
    expect(payload).toEqual({ warehouseId: WAREHOUSE_A, robots: [{ id: 'r1', status: 'moving' }] });

    await wait(50);
    expect(receivedByB).toBe(false); // room isolation - B never joined warehouse A

    watcherA.emit('warehouse:leave', WAREHOUSE_A);
    watcherB.emit('warehouse:leave', WAREHOUSE_B);
    watcherA.disconnect();
    watcherB.disconnect();
  });

  it('forwards robots:removed, obstacles:changed, orders:changed, and notification events', async () => {
    const client = await connectClient();
    client.emit('warehouse:join', WAREHOUSE_A);
    await wait(50);

    const removed = nextEvent(client, 'robots:removed');
    simulationEvents.emit('robots:removed', { warehouseId: WAREHOUSE_A, robotId: 'r1' });
    expect(await removed).toEqual({ warehouseId: WAREHOUSE_A, robotId: 'r1' });

    const obstacles = nextEvent(client, 'obstacles:changed');
    simulationEvents.emit('obstacles:changed', {
      warehouseId: WAREHOUSE_A,
      obstacles: [{ id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 1 }] }],
    });
    expect((await obstacles).obstacles).toHaveLength(1);

    const orders = nextEvent(client, 'orders:changed');
    simulationEvents.emit('orders:changed', { warehouseId: WAREHOUSE_A, reason: 'generated' });
    expect((await orders).reason).toBe('generated');

    const notification = nextEvent(client, 'notification');
    simulationEvents.emit('notification', {
      warehouseId: WAREHOUSE_A,
      level: 'warn',
      message: 'Robot r1 entered error state',
      timestamp: new Date().toISOString(),
    });
    expect((await notification).level).toBe('warn');

    client.emit('warehouse:leave', WAREHOUSE_A);
    client.disconnect();
  });
});

describe('simulation:start / simulation:stop', () => {
  it('starts a server-side tick loop that calls runTick repeatedly and broadcasts simulation:status', async () => {
    const client = await connectClient();
    client.emit('warehouse:join', WAREHOUSE_A);
    await wait(30);

    const statusOn = nextEvent(client, 'simulation:status');
    client.emit('simulation:start', { warehouseId: WAREHOUSE_A, deltaSeconds: 0.06 });
    expect(await statusOn).toEqual({ warehouseId: WAREHOUSE_A, running: true });

    await wait(200); // a few tick intervals at 60ms
    expect(runTick.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(runTick).toHaveBeenCalledWith(WAREHOUSE_A, 0.06);

    const statusOff = nextEvent(client, 'simulation:status');
    client.emit('simulation:stop', { warehouseId: WAREHOUSE_A });
    expect(await statusOff).toEqual({ warehouseId: WAREHOUSE_A, running: false });

    const callsAtStop = runTick.mock.calls.length;
    await wait(150);
    expect(runTick.mock.calls.length).toBe(callsAtStop); // no more ticks after stop

    client.emit('warehouse:leave', WAREHOUSE_A);
    client.disconnect();
  });

  it('keeps ticking for a second watcher even after the client who started it disconnects', async () => {
    const starter = await connectClient();
    const watcher = await connectClient();
    starter.emit('warehouse:join', WAREHOUSE_B);
    watcher.emit('warehouse:join', WAREHOUSE_B);
    await wait(30);

    starter.emit('simulation:start', { warehouseId: WAREHOUSE_B, deltaSeconds: 0.06 });
    await wait(80);
    const callsBeforeDisconnect = runTick.mock.calls.length;
    expect(callsBeforeDisconnect).toBeGreaterThanOrEqual(1);

    starter.disconnect(); // the starter leaves, but watcher is still in the room
    await wait(150);
    expect(runTick.mock.calls.length).toBeGreaterThan(callsBeforeDisconnect);

    watcher.emit('simulation:stop', { warehouseId: WAREHOUSE_B });
    watcher.emit('warehouse:leave', WAREHOUSE_B);
    watcher.disconnect();
  });

  it('auto-stops the loop once every client leaves the warehouse room', async () => {
    const client = await connectClient();
    client.emit('warehouse:join', WAREHOUSE_A);
    await wait(30);

    client.emit('simulation:start', { warehouseId: WAREHOUSE_A, deltaSeconds: 0.06 });
    await wait(80);
    expect(runTick.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Once this client leaves, it's no longer in the room - it can't be
    // the one to receive the resulting simulation:status broadcast (the
    // server emits to the room *after* the socket has already left it,
    // and stopIfIdle only fires once the room is empty in the first
    // place). So verify the stop by observing that runTick stops
    // advancing, rather than expecting this socket to hear its own event.
    client.emit('warehouse:leave', WAREHOUSE_A);
    await wait(30);
    const callsAtLeave = runTick.mock.calls.length;
    await wait(150);
    expect(runTick.mock.calls.length).toBe(callsAtLeave);

    client.disconnect();
  });
});

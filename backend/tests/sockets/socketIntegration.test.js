const http = require('http');
const { io: ioClient } = require('socket.io-client');

process.env.TICK_INTERVAL_MS = '60'; // fast enough to observe a few ticks without a slow test

// The loop drives `runAutoTick` (skip-if-busy), not `runTick`.
jest.mock('../../src/services/tickRunner', () => ({
  runAutoTick: jest.fn().mockResolvedValue({ skipped: false, value: null }),
}));

// Room membership is ownership-checked against this model on every
// warehouse-scoped event - see sockets/index.js.
jest.mock('../../src/models/Warehouse', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
  CELL_TYPES: ['shelf', 'charging', 'obstacle', 'dock'],
}));

const { runAutoTick } = require('../../src/services/tickRunner');
const Warehouse = require('../../src/models/Warehouse');
const simulationEvents = require('../../src/events/simulationEvents');
const initSockets = require('../../src/sockets');
const { tokenFor, makeUser, USER_A_ID } = require('../helpers/auth');

const WAREHOUSE_A = '507f1f77bcf86cd799439022';
const WAREHOUSE_B = '507f1f77bcf86cd799439033';

let httpServer;
let io;
let port;

const TOKEN = tokenFor(makeUser(USER_A_ID));

/** Connects an authenticated client socket and resolves once it's
 * actually connected. The handshake now requires a valid access token
 * (sockets/socketAuth.js); the unauthenticated and cross-tenant cases are
 * covered in tests/security/socket.test.js. */
function connectClient(token = TOKEN) {
  return new Promise((resolve, reject) => {
    const client = ioClient(`http://127.0.0.1:${port}`, {
      path: '/socket.io',
      forceNew: true,
      auth: { token },
    });
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

/**
 * Joins a warehouse room and waits for the *whole* join handshake, not
 * just the `warehouse:joined` acknowledgement.
 *
 * A join now answers with a resynchronisation burst - `simulation:sync`,
 * then `simulation:status`, then an `orders:changed` invalidation - so a
 * test that starts listening for `simulation:status` immediately after
 * `warehouse:joined` would catch the join's own status rather than the one
 * it went on to provoke. Waiting for the last event of the burst removes
 * the race.
 */
async function joinWarehouse(client, warehouseId) {
  const joined = nextEvent(client, 'warehouse:joined');
  const syncComplete = nextEvent(client, 'orders:changed');
  client.emit('warehouse:join', warehouseId);
  await Promise.all([joined, syncComplete]);
}

/** Disconnects clients and waits for the server to have processed it -
 * room membership is what `stopIfIdle` reads, and it is only updated once
 * the disconnect actually lands. */
async function closeClients(...clients) {
  for (const client of clients) client.disconnect();
  await wait(60);
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
  runAutoTick.mockResolvedValue({ skipped: false, value: null });
  // Joining a room now answers with a state snapshot, which asks the
  // simulation manager for the warehouse's engine. There is no engine to
  // build in this suite - the snapshot comes back empty, which is exactly
  // what a client joining a warehouse with nothing loaded should see.
  Warehouse.findById.mockResolvedValue(null);
  // The test user owns both warehouses. Access is resolved through
  // `findAccessibleWarehouse`, whose filter is
  // `{_id, $or: [{ownerId}, {'collaborators.userId'}]}`, so the asking
  // user comes out of the $or rather than off a top-level `ownerId`.
  Warehouse.findOne.mockImplementation((filter = {}) => {
    const id = String(filter._id);
    const asking = filter.ownerId ?? filter.$or?.[0]?.ownerId;
    const owns = String(asking) === USER_A_ID;
    if (!owns || (id !== WAREHOUSE_A && id !== WAREHOUSE_B)) return Promise.resolve(null);
    return Promise.resolve({
      _id: id,
      ownerId: USER_A_ID,
      rows: 20,
      cols: 20,
      cells: [],
      collaborators: [],
      dynamicObstacles: [],
    });
  });
});

describe('connection', () => {
  it('sends a server:welcome message on connect', async () => {
    // Subscribe before the handshake completes, not after awaiting
    // 'connect' first - the server emits server:welcome synchronously from
    // its own 'connection' handler, so listening only after our 'connect'
    // promise resolves is a race that can miss it.
    const client = ioClient(`http://127.0.0.1:${port}`, {
      path: '/socket.io',
      forceNew: true,
      auth: { token: TOKEN },
    });
    const welcome = await nextEvent(client, 'server:welcome');
    expect(welcome.message).toMatch(/warehouse simulation server/i);
    client.disconnect();
  });
});

describe('warehouse rooms', () => {
  it('delivers a robots:changed event only to clients that joined that warehouse', async () => {
    const watcherA = await connectClient();
    const watcherB = await connectClient();
    // The join is now asynchronous (an ownership lookup plus a state
    // snapshot), so wait for the server's handshake rather than a delay.
    await joinWarehouse(watcherA, WAREHOUSE_A);
    await joinWarehouse(watcherB, WAREHOUSE_B);

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
    await closeClients(watcherA, watcherB);
  });

  it('forwards robots:removed, obstacles:changed, orders:changed, and notification events', async () => {
    const client = await connectClient();
    await joinWarehouse(client, WAREHOUSE_A);

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
    await closeClients(client);
  });
});

describe('reconnection resynchronisation', () => {
  it('answers a join with an authoritative snapshot and the current status', async () => {
    // A reconnecting client has missed every broadcast made while it was
    // away, and Socket.IO dropped its room membership server-side - so
    // rejoining has to hand back the current state rather than leaving it
    // displaying whatever it had when the connection died.
    const client = await connectClient();
    const sync = nextEvent(client, 'simulation:sync');
    client.emit('warehouse:join', WAREHOUSE_A);

    const payload = await sync;
    expect(payload).toEqual(
      expect.objectContaining({
        warehouseId: WAREHOUSE_A,
        running: false,
        robots: [],
        obstacles: [],
      })
    );
    expect(typeof payload.serverTime).toBe('string');

    await closeClients(client);
  });

  it('serves simulation:sync on demand, not only at join time', async () => {
    const client = await connectClient();
    await joinWarehouse(client, WAREHOUSE_A);

    const resync = nextEvent(client, 'simulation:sync');
    client.emit('simulation:sync', { warehouseId: WAREHOUSE_A });
    expect(await resync).toEqual(expect.objectContaining({ warehouseId: WAREHOUSE_A }));

    client.emit('warehouse:leave', WAREHOUSE_A);
    await closeClients(client);
  });

  it('reports a running simulation to a client that joins after it started', async () => {
    const starter = await connectClient();
    await joinWarehouse(starter, WAREHOUSE_B);
    starter.emit('simulation:start', { warehouseId: WAREHOUSE_B, deltaSeconds: 0.06 });
    await wait(40);

    const latecomer = await connectClient();
    const sync = nextEvent(latecomer, 'simulation:sync');
    latecomer.emit('warehouse:join', WAREHOUSE_B);
    expect(await sync).toEqual(expect.objectContaining({ warehouseId: WAREHOUSE_B, running: true }));

    starter.emit('simulation:stop', { warehouseId: WAREHOUSE_B });
    starter.emit('warehouse:leave', WAREHOUSE_B);
    latecomer.emit('warehouse:leave', WAREHOUSE_B);
    await closeClients(starter, latecomer);
  });
});

describe('simulation:start / simulation:stop', () => {
  it('starts a server-side tick loop that calls runTick repeatedly and broadcasts simulation:status', async () => {
    const client = await connectClient();
    await joinWarehouse(client, WAREHOUSE_A);

    const statusOn = nextEvent(client, 'simulation:status');
    client.emit('simulation:start', { warehouseId: WAREHOUSE_A, deltaSeconds: 0.06 });
    // The status now carries the loop's own bookkeeping (cadence, start
    // time, tick counters) so a client can render the running state
    // without having to have watched it start.
    expect(await statusOn).toEqual(
      expect.objectContaining({ warehouseId: WAREHOUSE_A, running: true, deltaSeconds: 0.06 })
    );

    await wait(200); // a few tick intervals at 60ms
    expect(runAutoTick.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The step is measured elapsed time rather than the nominal delta, so
    // it tracks the requested cadence without ever being exactly it - a
    // late interval advances the world by how late it was. Asserting the
    // exact value would be asserting that the host was never busy.
    for (const [warehouseId, delta] of runAutoTick.mock.calls) {
      expect(warehouseId).toBe(WAREHOUSE_A);
      expect(delta).toBeGreaterThanOrEqual(0.06);
      expect(delta).toBeLessThan(0.5);
    }

    const statusOff = nextEvent(client, 'simulation:status');
    client.emit('simulation:stop', { warehouseId: WAREHOUSE_A });
    expect(await statusOff).toEqual(
      expect.objectContaining({ warehouseId: WAREHOUSE_A, running: false })
    );

    const callsAtStop = runAutoTick.mock.calls.length;
    await wait(150);
    expect(runAutoTick.mock.calls.length).toBe(callsAtStop); // no more ticks after stop

    client.emit('warehouse:leave', WAREHOUSE_A);
    await closeClients(client);
  });

  it('keeps ticking for a second watcher even after the client who started it disconnects', async () => {
    const starter = await connectClient();
    const watcher = await connectClient();
    await joinWarehouse(starter, WAREHOUSE_B);
    await joinWarehouse(watcher, WAREHOUSE_B);

    starter.emit('simulation:start', { warehouseId: WAREHOUSE_B, deltaSeconds: 0.06 });
    await wait(120);
    const callsBeforeDisconnect = runAutoTick.mock.calls.length;
    expect(callsBeforeDisconnect).toBeGreaterThanOrEqual(1);

    starter.disconnect(); // the starter leaves, but watcher is still in the room
    await wait(150);
    expect(runAutoTick.mock.calls.length).toBeGreaterThan(callsBeforeDisconnect);

    watcher.emit('simulation:stop', { warehouseId: WAREHOUSE_B });
    watcher.emit('warehouse:leave', WAREHOUSE_B);
    await closeClients(watcher);
  });

  it('acknowledges a duplicate start without starting a second loop', async () => {
    const client = await connectClient();
    await joinWarehouse(client, WAREHOUSE_A);

    client.emit('simulation:start', { warehouseId: WAREHOUSE_A, deltaSeconds: 0.06 });
    await wait(30);

    // A second start must be answered - a client that hears nothing back
    // cannot tell "already running" from "my request was dropped" - but it
    // must not create a second interval.
    const ack = new Promise((resolve) => {
      client.on('simulation:status', (payload) => {
        if (payload.changed === false) resolve(payload);
      });
    });
    client.emit('simulation:start', { warehouseId: WAREHOUSE_A, deltaSeconds: 0.06 });
    const payload = await ack;
    expect(payload).toEqual(expect.objectContaining({ running: true, changed: false }));

    await wait(120);
    const callsWithTwoStarts = runAutoTick.mock.calls.length;
    // One interval at 60ms cannot have produced anywhere near the tick
    // count two overlapping intervals would.
    expect(callsWithTwoStarts).toBeLessThan(8);

    client.emit('simulation:stop', { warehouseId: WAREHOUSE_A });
    client.emit('warehouse:leave', WAREHOUSE_A);
    await closeClients(client);
  });

  it('acknowledges a duplicate stop rather than leaving the client guessing', async () => {
    const client = await connectClient();
    await joinWarehouse(client, WAREHOUSE_A);

    const first = nextEvent(client, 'simulation:status');
    client.emit('simulation:stop', { warehouseId: WAREHOUSE_A });
    expect(await first).toEqual(
      expect.objectContaining({ warehouseId: WAREHOUSE_A, running: false, changed: false })
    );

    client.emit('warehouse:leave', WAREHOUSE_A);
    await closeClients(client);
  });

  it('auto-stops the loop once every client leaves the warehouse room', async () => {
    const client = await connectClient();
    await joinWarehouse(client, WAREHOUSE_A);

    client.emit('simulation:start', { warehouseId: WAREHOUSE_A, deltaSeconds: 0.06 });
    await wait(120);
    expect(runAutoTick.mock.calls.length).toBeGreaterThanOrEqual(1);

    // Once this client leaves, it's no longer in the room - it can't be
    // the one to receive the resulting simulation:status broadcast (the
    // server emits to the room *after* the socket has already left it,
    // and stopIfIdle only fires once the room is empty in the first
    // place). So verify the stop by observing that runTick stops
    // advancing, rather than expecting this socket to hear its own event.
    client.emit('warehouse:leave', WAREHOUSE_A);
    await wait(80);
    const callsAtLeave = runAutoTick.mock.calls.length;
    await wait(150);
    expect(runAutoTick.mock.calls.length).toBe(callsAtLeave);

    await closeClients(client);
  });
});

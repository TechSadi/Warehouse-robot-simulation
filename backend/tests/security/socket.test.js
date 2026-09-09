/**
 * Socket.IO security: handshake authentication, room authorization,
 * per-event authorization, payload validation, and event rate limiting.
 *
 * Socket.IO does not run through Express's middleware stack, so none of
 * the HTTP hardening applies to it. Before this phase the channel was
 * entirely open: connect anonymously, `warehouse:join` any id you cared to
 * guess, and receive live robot positions and order events - or start and
 * stop the simulation.
 */
const http = require('http');
const { io: ioClient } = require('socket.io-client');

process.env.TICK_INTERVAL_MS = '60';

jest.mock('../../src/services/tickRunner', () => ({
  // The loop drives `runAutoTick` (skip-if-busy), not `runTick`.
  runAutoTick: jest.fn().mockResolvedValue({ skipped: false, value: null }),
}));

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
const { tokenFor, makeUser, USER_A_ID, USER_B_ID } = require('../helpers/auth');
const { ACCESS_COOKIE } = require('../../src/utils/tokens');

const OWNED_WAREHOUSE = '507f1f77bcf86cd799439022';
const OTHER_WAREHOUSE = '507f1f77bcf86cd799439033';

const TOKEN_A = tokenFor(makeUser(USER_A_ID));
const TOKEN_B = tokenFor(makeUser(USER_B_ID));

let httpServer;
let io;
let port;

function connect(options = {}) {
  return ioClient(`http://127.0.0.1:${port}`, { path: '/socket.io', forceNew: true, ...options });
}

function connected(client) {
  return new Promise((resolve, reject) => {
    client.on('connect', () => resolve(client));
    client.on('connect_error', reject);
  });
}

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
  delete process.env.TICK_INTERVAL_MS;
  io.close();
  httpServer.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  // User A owns OWNED_WAREHOUSE. User B owns OTHER_WAREHOUSE. Neither is
  // shared with anyone, so "can reach it" and "owns it" coincide here -
  // sharing has its own coverage in tests/security/sharing.test.js.
  //
  // The socket layer resolves access through `findAccessibleWarehouse`,
  // whose filter is `{_id, $or: [{ownerId}, {'collaborators.userId'}]}`,
  // so the asking user comes out of the $or rather than off `ownerId`.
  const owners = { [OWNED_WAREHOUSE]: USER_A_ID, [OTHER_WAREHOUSE]: USER_B_ID };
  Warehouse.findOne.mockImplementation((filter = {}) => {
    const owner = owners[String(filter._id)];
    const asking = filter.ownerId ?? filter.$or?.[0]?.ownerId;
    if (!owner || String(asking) !== owner) return Promise.resolve(null);
    return Promise.resolve({
      _id: String(filter._id),
      ownerId: owner,
      rows: 20,
      cols: 20,
      cells: [],
      collaborators: [],
      dynamicObstacles: [],
    });
  });
});

describe('connection authentication', () => {
  it('refuses a handshake with no token', async () => {
    const client = connect();
    await expect(connected(client)).rejects.toThrow(/UNAUTHENTICATED/);
    client.close();
  });

  it('refuses a handshake with a forged token', async () => {
    const client = connect({ auth: { token: `${TOKEN_A.slice(0, -4)}AAAA` } });
    await expect(connected(client)).rejects.toThrow(/UNAUTHENTICATED/);
    client.close();
  });

  it('refuses a handshake with a syntactically invalid token', async () => {
    const client = connect({ auth: { token: 'not.a.jwt' } });
    await expect(connected(client)).rejects.toThrow(/UNAUTHENTICATED/);
    client.close();
  });

  it('accepts a valid token in the handshake auth field', async () => {
    const client = await connected(connect({ auth: { token: TOKEN_A } }));
    expect(client.connected).toBe(true);
    client.disconnect();
  });

  it('accepts the httpOnly access cookie a browser sends automatically', async () => {
    const client = await connected(
      connect({ extraHeaders: { Cookie: `${ACCESS_COOKIE}=${TOKEN_A}` } })
    );
    expect(client.connected).toBe(true);
    client.disconnect();
  });
});

describe('room authorization', () => {
  it("refuses to join another user's warehouse room", async () => {
    const client = await connected(connect({ auth: { token: TOKEN_A } }));

    const denied = nextEvent(client, 'error:unauthorized');
    client.emit('warehouse:join', OTHER_WAREHOUSE);
    const payload = await denied;

    expect(payload.event).toBe('warehouse:join');
    // Same non-committal wording as the REST 404 - a client cannot sweep
    // ObjectIds over this socket to learn which warehouses exist.
    expect(payload.message).toBe('Warehouse not found');
    client.disconnect();
  });

  it("does not deliver a warehouse's events to a client denied its room", async () => {
    const intruder = await connected(connect({ auth: { token: TOKEN_A } }));
    const denied = nextEvent(intruder, 'error:unauthorized');
    intruder.emit('warehouse:join', OTHER_WAREHOUSE);
    await denied;

    let received = false;
    intruder.once('robots:changed', () => {
      received = true;
    });

    simulationEvents.emit('robots:changed', {
      warehouseId: OTHER_WAREHOUSE,
      robots: [{ id: 'r1', position: { x: 4, y: 4 } }],
    });

    await wait(80);
    expect(received).toBe(false);
    intruder.disconnect();
  });

  it('lets the owner join their own warehouse room', async () => {
    const client = await connected(connect({ auth: { token: TOKEN_A } }));
    const joined = nextEvent(client, 'warehouse:joined');
    client.emit('warehouse:join', OWNED_WAREHOUSE);

    expect((await joined).warehouseId).toBe(OWNED_WAREHOUSE);
    client.disconnect();
  });

  it('authorizes each user against their own warehouse independently', async () => {
    const a = await connected(connect({ auth: { token: TOKEN_A } }));
    const b = await connected(connect({ auth: { token: TOKEN_B } }));

    const joinedA = nextEvent(a, 'warehouse:joined');
    const joinedB = nextEvent(b, 'warehouse:joined');
    a.emit('warehouse:join', OWNED_WAREHOUSE);
    b.emit('warehouse:join', OTHER_WAREHOUSE);

    expect((await joinedA).warehouseId).toBe(OWNED_WAREHOUSE);
    expect((await joinedB).warehouseId).toBe(OTHER_WAREHOUSE);

    a.disconnect();
    b.disconnect();
  });
});

describe('event authorization for expensive operations', () => {
  it("refuses to start another user's simulation, even without joining its room", async () => {
    // Authorizing only at join time would leave this wide open: starting
    // someone else's simulation does not require being able to see it.
    const client = await connected(connect({ auth: { token: TOKEN_A } }));

    const denied = nextEvent(client, 'error:unauthorized');
    client.emit('simulation:start', { warehouseId: OTHER_WAREHOUSE, deltaSeconds: 0.06 });
    expect((await denied).event).toBe('simulation:start');

    await wait(150);
    expect(runAutoTick).not.toHaveBeenCalled();
    client.disconnect();
  });

  it("refuses to stop another user's running simulation", async () => {
    const owner = await connected(connect({ auth: { token: TOKEN_B } }));
    const joined = nextEvent(owner, 'warehouse:joined');
    owner.emit('warehouse:join', OTHER_WAREHOUSE);
    await joined;
    owner.emit('simulation:start', { warehouseId: OTHER_WAREHOUSE, deltaSeconds: 0.06 });
    await wait(120);
    const callsWhileRunning = runAutoTick.mock.calls.length;
    expect(callsWhileRunning).toBeGreaterThanOrEqual(1);

    const intruder = await connected(connect({ auth: { token: TOKEN_A } }));
    const denied = nextEvent(intruder, 'error:unauthorized');
    intruder.emit('simulation:stop', { warehouseId: OTHER_WAREHOUSE });
    await denied;

    await wait(120);
    expect(runAutoTick.mock.calls.length).toBeGreaterThan(callsWhileRunning); // still running

    owner.emit('simulation:stop', { warehouseId: OTHER_WAREHOUSE });
    await wait(30);
    intruder.disconnect();
    owner.disconnect();
  });
});

describe('payload validation', () => {
  it('rejects a non-ObjectId warehouse id', async () => {
    const client = await connected(connect({ auth: { token: TOKEN_A } }));

    const invalid = nextEvent(client, 'error:validation');
    client.emit('warehouse:join', 'not-an-object-id');
    expect((await invalid).message).toMatch(/ObjectId/i);

    client.disconnect();
  });

  it('rejects an object where a warehouse id belongs (query injection)', async () => {
    const client = await connected(connect({ auth: { token: TOKEN_A } }));

    const invalid = nextEvent(client, 'error:validation');
    client.emit('warehouse:join', { warehouseId: { $ne: null } });
    expect((await invalid).message).toMatch(/string/i);

    expect(Warehouse.findOne).not.toHaveBeenCalled();
    client.disconnect();
  });

  it('rejects an absurd deltaSeconds rather than blocking the process on it', async () => {
    // The engine advances every robot by speed * deltaSeconds inside one
    // synchronous loop - an unbounded value is a single event that hangs
    // the server.
    const client = await connected(connect({ auth: { token: TOKEN_A } }));

    const invalid = nextEvent(client, 'error:validation');
    client.emit('simulation:start', { warehouseId: OWNED_WAREHOUSE, deltaSeconds: 1e9 });
    expect((await invalid).message).toMatch(/deltaSeconds/);

    client.disconnect();
  });

  it('rejects a NaN deltaSeconds', async () => {
    const client = await connected(connect({ auth: { token: TOKEN_A } }));

    const invalid = nextEvent(client, 'error:validation');
    client.emit('simulation:start', { warehouseId: OWNED_WAREHOUSE, deltaSeconds: 'fast' });
    expect((await invalid).message).toMatch(/finite number/);

    client.disconnect();
  });

  it('rejects a missing payload entirely', async () => {
    const client = await connected(connect({ auth: { token: TOKEN_A } }));

    const invalid = nextEvent(client, 'error:validation');
    client.emit('simulation:start');
    expect((await invalid).message).toBeDefined();

    client.disconnect();
  });
});

describe('event rate limiting', () => {
  it('cuts off a client flooding an expensive event', async () => {
    const client = await connected(connect({ auth: { token: TOKEN_A } }));

    const limited = nextEvent(client, 'error:rate_limit');
    // The simulation:start bucket holds 10 tokens and refills slowly.
    for (let i = 0; i < 40; i += 1) {
      client.emit('simulation:start', { warehouseId: OWNED_WAREHOUSE, deltaSeconds: 0.06 });
    }

    const payload = await limited;
    expect(payload.event).toBe('simulation:start');
    expect(payload.message).toMatch(/rate limit/i);

    client.emit('simulation:stop', { warehouseId: OWNED_WAREHOUSE });
    await wait(30);
    client.disconnect();
  });

  it('limits room joins, so a client cannot sweep warehouse ids over one socket', async () => {
    const client = await connected(connect({ auth: { token: TOKEN_A } }));

    const limited = nextEvent(client, 'error:rate_limit');
    for (let i = 0; i < 60; i += 1) {
      client.emit('warehouse:join', OTHER_WAREHOUSE);
    }

    expect((await limited).event).toBe('warehouse:join');
    client.disconnect();
  });

  it('keeps each socket on its own budget', async () => {
    const noisy = await connected(connect({ auth: { token: TOKEN_A } }));
    const quiet = await connected(connect({ auth: { token: TOKEN_A } }));

    const limited = nextEvent(noisy, 'error:rate_limit');
    for (let i = 0; i < 60; i += 1) noisy.emit('warehouse:join', OWNED_WAREHOUSE);
    await limited;

    // The second socket is unaffected by the first one's spending.
    const joined = nextEvent(quiet, 'warehouse:joined');
    quiet.emit('warehouse:join', OWNED_WAREHOUSE);
    expect((await joined).warehouseId).toBe(OWNED_WAREHOUSE);

    noisy.disconnect();
    quiet.disconnect();
  });
});

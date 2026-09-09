import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The flows that have to work for this app to be worth running at all,
 * exercised through the real component tree with only the network and the
 * socket transport replaced.
 *
 * Everything below the API client and the socket is the actual application:
 * the auth provider, the connection manager, the state hooks, and every
 * panel. That is deliberate - the bugs this phase fixed (a socket that
 * never recovered from an expired session, a snapshot race that rewound
 * robot positions, commands silently buffered while offline) all lived in
 * the seams *between* those pieces, where a unit test with everything
 * mocked sees nothing.
 */

const socketState = { handlers: new Map(), connected: false, emitted: [] };

function socketOn(event, handler) {
  if (!socketState.handlers.has(event)) socketState.handlers.set(event, new Set());
  socketState.handlers.get(event).add(handler);
}

vi.mock('socket.io-client', () => ({
  io: () => ({
    get connected() {
      return socketState.connected;
    },
    on: socketOn,
    off: (event, handler) => socketState.handlers.get(event)?.delete(handler),
    emit: (event, payload) => socketState.emitted.push({ event, payload }),
    connect: () => {
      socketState.connectRequested = (socketState.connectRequested || 0) + 1;
    },
    disconnect: () => {
      const was = socketState.connected;
      socketState.connected = false;
      if (was) fireSocket('disconnect', 'io client disconnect');
    },
    io: { on: () => {} },
  }),
}));

function fireSocket(event, ...args) {
  for (const handler of [...(socketState.handlers.get(event) || [])]) handler(...args);
}

/** Brings the mocked socket up, exactly as a real handshake would. */
function connectSocket() {
  act(() => {
    socketState.connected = true;
    fireSocket('connect');
  });
}

function dropSocket(reason = 'transport close') {
  act(() => {
    socketState.connected = false;
    fireSocket('disconnect', reason);
  });
}

function serverEmit(event, payload) {
  act(() => {
    fireSocket(event, payload);
  });
}

function emitsOf(event) {
  return socketState.emitted.filter((entry) => entry.event === event);
}

const App = (await import('../../src/App.jsx')).default;

// --- Fake API ----------------------------------------------------------------

const USER = { id: 'u1', email: 'ops@example.com', name: 'Ops' };
const WAREHOUSE = {
  _id: 'w1',
  name: 'Depot',
  rows: 10,
  cols: 10,
  cells: [],
  schedulingStrategy: 'nearest_robot',
  updatedAt: '2026-01-01T10:00:00Z',
};

/** Routes fetch calls by URL, so tests describe server behaviour rather
 * than the order the app happens to call things in. */
function installApi(overrides = {}) {
  const state = {
    user: null,
    robots: [],
    orders: [],
    obstacles: [],
    warehouses: [],
    logs: [],
    ...overrides,
  };

  const calls = [];

  global.fetch = vi.fn(async (url, options = {}) => {
    const path = String(url).replace('/api', '');
    const method = (options.method || 'GET').toUpperCase();
    calls.push({ path, method });

    const ok = (data, status = 200) => ({ ok: true, status, json: async () => ({ success: true, data }) });
    const fail = (status, message) => ({
      ok: false,
      status,
      json: async () => ({ success: false, error: { message } }),
    });

    if (state.failEverything) return fail(state.failEverything.status, state.failEverything.message);

    if (path === '/health') return ok({ status: 'ok' });

    if (path === '/auth/me') {
      return state.user ? ok({ user: state.user }) : fail(401, 'Unauthenticated');
    }
    if (path === '/auth/login') {
      if (state.loginFails) return fail(401, 'Invalid email or password');
      state.user = USER;
      return ok({ user: USER });
    }
    if (path === '/auth/register') {
      state.user = USER;
      return ok({ user: USER });
    }
    if (path === '/auth/logout') {
      state.user = null;
      return ok({});
    }
    if (path === '/auth/refresh') return state.refreshWorks ? ok({}) : fail(401, 'Session expired');

    // Every other route requires a session, exactly as the real API does
    // (backend/src/routes/index.js mounts requireAuth on all of them).
    if (!state.user) return fail(401, 'Unauthenticated');

    if (path.startsWith('/warehouses?')) return ok(state.warehouses);
    if (path === '/warehouses' && method === 'POST') {
      state.warehouses = [WAREHOUSE, ...state.warehouses];
      return ok(WAREHOUSE, 201);
    }
    if (path.startsWith('/warehouses/w1/obstacles')) {
      if (method === 'GET') return ok(state.obstacles);
      if (method === 'POST') return ok({ id: 'o1' }, 201);
      return { ok: true, status: 204, json: async () => null };
    }
    if (path === '/warehouses/w1/orders/generate') {
      if (state.generateFails) return fail(state.generateFails, 'Too many requests');
      return ok({ created: 5 });
    }
    if (path === '/warehouses/w1/orders/dispatch') return ok({ assigned: 1 });
    if (path === '/warehouses/w1') return method === 'GET' ? ok(WAREHOUSE) : ok(WAREHOUSE);

    if (path.startsWith('/robots?')) return ok(state.robots);
    if (path === '/robots' && method === 'POST') return ok({ id: 'r1' }, 201);
    if (path.startsWith('/orders?')) return ok(state.orders);
    if (path.startsWith('/logs?')) return ok(state.logs);

    return ok({});
  });

  return { state, calls };
}

async function signIn(user) {
  await user.type(screen.getByLabelText('Email'), 'ops@example.com');
  await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

/** Syncs the current layout - the precondition for everything live.
 * Assumes the dashboard is already on screen. */
async function syncLayout(user) {
  connectSocket();
  await user.click(screen.getByRole('button', { name: /sync layout to server/i }));
  await screen.findByRole('button', { name: /re-sync layout/i });
}

beforeEach(() => {
  // Deliberately *not* clearing socketState.handlers: the realtime client is
  // a module singleton that registers its lifecycle listeners once, at
  // import. Replacing the handler map between tests would silently unhook
  // them and make every reconnect assertion below pass vacuously. Component
  // listeners are removed by React's own unmount cleanup.
  socketState.connected = false;
  socketState.emitted = [];
  socketState.connectRequested = 0;
  document.cookie = 'wrs_csrf=token';
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Flows -------------------------------------------------------------------

describe('login', () => {
  it('shows the sign-in gate when nobody is signed in', async () => {
    installApi();
    render(<App />);

    expect(screen.getByRole('status')).toHaveTextContent(/checking your session/i);
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByRole('button', { name: /sync layout/i })).not.toBeInTheDocument();
  });

  it('signs in and opens the dashboard', async () => {
    const user = userEvent.setup();
    installApi();
    render(<App />);
    await screen.findByRole('button', { name: 'Sign in' });

    await signIn(user);

    await screen.findByRole('button', { name: /sync layout to server/i });
    expect(screen.getByText('Ops')).toBeInTheDocument();
  });

  it("shows the server's message verbatim on bad credentials, and stays on the gate", async () => {
    const user = userEvent.setup();
    installApi({ loginFails: true });
    render(<App />);
    await screen.findByRole('button', { name: 'Sign in' });

    await signIn(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('restores an existing session on load without asking again', async () => {
    installApi({ user: USER });
    render(<App />);

    await screen.findByRole('button', { name: /sync layout to server/i });
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('opens the live connection once, on sign-in', async () => {
    const user = userEvent.setup();
    installApi();
    render(<App />);
    await screen.findByRole('button', { name: 'Sign in' });
    expect(socketState.connectRequested).toBe(0);

    await signIn(user);
    await screen.findByRole('button', { name: /sync layout to server/i });

    expect(socketState.connectRequested).toBe(1);
  });
});

describe('warehouse, robot and order loading', () => {
  it('syncs a layout, then loads its robots, orders and obstacles', async () => {
    const user = userEvent.setup();
    const { calls } = installApi({
      user: USER,
      robots: [{ id: 'r1', name: 'Robot 1', status: 'idle', battery: 90, position: { x: 1, y: 1 } }],
      orders: [
        {
          _id: 'o1',
          status: 'pending',
          priority: 'urgent',
          pickupLocation: { x: 1, y: 1 },
          deliveryLocation: { x: 8, y: 8 },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    connectSocket();

    await user.click(screen.getByRole('button', { name: /sync layout to server/i }));

    await screen.findByText('Robot 1');
    expect(await screen.findByRole('heading', { name: /active orders \(1\)/i })).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/robots?warehouseId=w1'))).toBe(true);
    expect(calls.some((c) => c.path.startsWith('/warehouses/w1/obstacles'))).toBe(true);
  });

  it('joins the warehouse room so the server starts pushing updates', async () => {
    const user = userEvent.setup();
    installApi({ user: USER });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    connectSocket();

    await user.click(screen.getByRole('button', { name: /sync layout to server/i }));

    await waitFor(() => expect(emitsOf('warehouse:join')).toHaveLength(1));
    expect(emitsOf('warehouse:join')[0].payload).toBe('w1');
  });

  it('shows empty states, not blanks, before anything exists', async () => {
    installApi({ user: USER });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });

    expect(screen.getByText(/no robots yet/i)).toBeInTheDocument();
    expect(screen.getByText('No orders yet.')).toBeInTheDocument();
    expect(screen.getByText(/no simulation yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no warehouse synced/i)).toBeInTheDocument();
    // The chart panel is lazily loaded, so this one is awaited rather than
    // read synchronously like the panels above it.
    expect(await screen.findByText(/no activity recorded/i)).toBeInTheDocument();
  });
});

describe('simulation start, updates and stop', () => {
  it('starts the simulation and reports it as running', async () => {
    const user = userEvent.setup();
    installApi({ user: USER });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    await syncLayout(user);

    await user.click(await screen.findByRole('button', { name: /start simulation/i }));

    expect(emitsOf('simulation:start')).toHaveLength(1);
    // Optimistic locally, then confirmed by the server.
    serverEmit('simulation:status', { warehouseId: 'w1', running: true });
    expect(screen.getByText('Simulation running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop simulation/i })).toBeInTheDocument();
  });

  it('moves robots on the roster as tick events arrive', async () => {
    const user = userEvent.setup();
    installApi({
      user: USER,
      robots: [{ id: 'r1', name: 'Robot 1', status: 'idle', battery: 90, position: { x: 0, y: 0 } }],
    });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    await syncLayout(user);
    await screen.findByText('Robot 1');

    serverEmit('robots:changed', {
      warehouseId: 'w1',
      robots: [{ id: 'r1', status: 'moving', battery: 88, position: { x: 4, y: 2 } }],
    });

    const row = screen.getByText('Robot 1').closest('li');
    expect(within(row).getByText('Moving')).toBeInTheDocument();
    expect(within(row).getByText(/X:4 Y:2 · 88%/)).toBeInTheDocument();
  });

  it('surfaces delivery notifications from the live feed', async () => {
    const user = userEvent.setup();
    installApi({ user: USER });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    await syncLayout(user);

    serverEmit('notification', {
      warehouseId: 'w1',
      message: 'Order o1 delivered',
      level: 'info',
      timestamp: Date.now(),
    });

    expect(await screen.findByText(/order o1 delivered/i)).toBeInTheDocument();
  });

  it('stops the simulation', async () => {
    const user = userEvent.setup();
    installApi({ user: USER });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    await syncLayout(user);
    await user.click(await screen.findByRole('button', { name: /start simulation/i }));
    serverEmit('simulation:status', { warehouseId: 'w1', running: true });

    await user.click(screen.getByRole('button', { name: /stop simulation/i }));
    serverEmit('simulation:status', { warehouseId: 'w1', running: false });

    expect(emitsOf('simulation:stop')).toHaveLength(1);
    expect(screen.getByText('Simulation stopped')).toBeInTheDocument();
  });
});

describe('socket disconnect and reconnect', () => {
  it('tells the user the view is no longer live and disables the controls', async () => {
    const user = userEvent.setup();
    installApi({ user: USER });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    await syncLayout(user);

    dropSocket();

    expect(await screen.findByText(/last state received/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start simulation/i })).toBeDisabled();
    // The top bar and the simulation panel describe the same connection
    // with the same word - they read from one shared vocabulary.
    expect(screen.getAllByText('Disconnected').length).toBeGreaterThanOrEqual(2);
  });

  it('rejoins the room on reconnect without any panel having to ask', async () => {
    const user = userEvent.setup();
    installApi({ user: USER });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    await syncLayout(user);
    await waitFor(() => expect(emitsOf('warehouse:join')).toHaveLength(1));

    dropSocket();
    connectSocket();

    // Exactly one rejoin: the connection layer owns it, so a second
    // subscriber cannot cause a duplicate.
    await waitFor(() => expect(emitsOf('warehouse:join')).toHaveLength(2));
    expect(screen.getAllByText('Reconnected').length).toBeGreaterThanOrEqual(1);
  });

  it('discards state that changed during the outage when the resync lands', async () => {
    const user = userEvent.setup();
    installApi({
      user: USER,
      robots: [
        { id: 'r1', name: 'Robot 1', status: 'idle', battery: 90, position: { x: 0, y: 0 } },
        { id: 'r2', name: 'Robot 2', status: 'idle', battery: 90, position: { x: 1, y: 0 } },
      ],
    });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    await syncLayout(user);
    await screen.findByText('Robot 2');

    dropSocket();
    connectSocket();
    // Robot 2 was deleted while we were away. No incremental event will ever
    // mention it again, so only a full replace can remove it from the roster.
    serverEmit('simulation:sync', {
      warehouseId: 'w1',
      robots: [{ id: 'r1', name: 'Robot 1', status: 'moving', battery: 70, position: { x: 5, y: 5 } }],
      obstacles: [],
      running: true,
    });

    await waitFor(() => expect(screen.queryByText('Robot 2')).not.toBeInTheDocument());
    expect(screen.getByText('Robot 1')).toBeInTheDocument();
    expect(screen.getByText('Simulation running')).toBeInTheDocument();
  });

  it('refuses to buffer a start command issued while disconnected', async () => {
    const user = userEvent.setup();
    installApi({ user: USER });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    await syncLayout(user);
    dropSocket();
    socketState.emitted.length = 0;

    // The button is disabled, so a click cannot even reach the handler -
    // which is the point: the command is refused visibly, not silently
    // queued for delivery minutes later.
    await user.click(screen.getByRole('button', { name: /start simulation/i }));

    expect(emitsOf('simulation:start')).toHaveLength(0);
    expect(screen.getByText('Simulation stopped')).toBeInTheDocument();
  });
});

describe('API failure and unauthorized responses', () => {
  it('reports an unreachable API separately from the live connection', async () => {
    installApi({ user: USER });
    // Session restore succeeds; every call after it fails at the transport,
    // which is what an API that dies while a dashboard is open looks like.
    const realFetch = global.fetch;
    let calls = 0;
    global.fetch = vi.fn(async (...args) => {
      calls += 1;
      if (calls > 1 && String(args[0]).includes('/health')) throw new TypeError('Failed to fetch');
      return realFetch(...args);
    });

    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    connectSocket();

    // The API is down while the socket is up - the two pills must be able to
    // disagree, which a single merged status could never express.
    expect(await screen.findByText('API unreachable')).toBeInTheDocument();
    expect(screen.getAllByText('Live').length).toBeGreaterThanOrEqual(1);
  });

  it('turns a failed command into an actionable message rather than a stack trace', async () => {
    const user = userEvent.setup();
    const api = installApi({ user: USER });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    await syncLayout(user);

    api.state.generateFails = 429;
    await user.click(await screen.findByRole('button', { name: /generate orders/i }));

    expect(await screen.findByText('Too many requests')).toBeInTheDocument();
  });

  it('drops back to the sign-in gate when the session is gone for good', async () => {
    const user = userEvent.setup();
    const api = installApi({ user: USER, refreshWorks: false });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });

    // Every subsequent call 401s and the refresh cannot fix it - a revoked
    // session, or "sign out everywhere" from another device.
    api.state.user = null;
    await user.click(screen.getByRole('button', { name: /sync layout to server/i }));

    await screen.findByRole('button', { name: 'Sign in' });
  });

  it('keeps the rest of the dashboard alive when one panel fails to load', async () => {
    const user = userEvent.setup();
    installApi({ user: USER });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    connectSocket();

    await user.click(screen.getByRole('button', { name: /sync layout to server/i }));
    serverEmit('error:unauthorized', { event: 'simulation:start', message: 'Warehouse not found' });

    expect(await screen.findByText('Warehouse not found')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /fleet roster/i })).toBeInTheDocument();
  });
});

describe('logout', () => {
  it('signs out, closes the live connection, and returns to the gate', async () => {
    const user = userEvent.setup();
    installApi({ user: USER });
    render(<App />);
    await screen.findByRole('button', { name: /sync layout to server/i });
    connectSocket();

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await screen.findByRole('button', { name: 'Sign in' });
    expect(socketState.connected).toBe(false);
  });
});

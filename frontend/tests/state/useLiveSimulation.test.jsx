import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// The hook talks to two collaborators: the REST client and the realtime
// client. Both are mocked so the test can drive exactly the sequences that
// are hard to produce for real - a reconnect, a burst of invalidations, a
// slow response landing after the user moved on.
vi.mock('../../src/api/client.js', () => ({
  listRobots: vi.fn(),
  listOrders: vi.fn(),
  listObstacles: vi.fn(),
  spawnRobot: vi.fn(),
  generateOrders: vi.fn(),
  dispatchOrders: vi.fn(),
  addObstacle: vi.fn(),
  removeObstacle: vi.fn(),
  // The real realtime module imports this at construction time; the mock
  // has to provide it even though nothing in this file exercises it.
  refreshSession: vi.fn(async () => true),
}));

const socketHandlers = { current: {} };
const realtimeState = { current: { status: 'connected', attempts: 0, error: null } };

vi.mock('../../src/api/realtime.js', async () => {
  const actual = await vi.importActual('../../src/api/realtime.js');
  return {
    ...actual,
    realtime: {
      on: vi.fn((handlers) => {
        socketHandlers.current = { ...socketHandlers.current, ...handlers };
        return () => {
          for (const key of Object.keys(handlers)) delete socketHandlers.current[key];
        };
      }),
      joinWarehouse: vi.fn(() => vi.fn()),
      emit: vi.fn(() => true),
      isConnected: vi.fn(() => true),
      getState: () => realtimeState.current,
      subscribe: () => () => {},
      requestSync: vi.fn(),
    },
  };
});

const api = await import('../../src/api/client.js');
const { realtime } = await import('../../src/api/realtime.js');
const { useLiveSimulation, SIMULATION_PHASE } = await import('../../src/state/useLiveSimulation.js');

const GRID = { rows: 5, cols: 5, cells: new Map() };
const WAREHOUSE = 'w1';

const robot = (id, overrides = {}) => ({
  id,
  name: `Robot ${id}`,
  status: 'idle',
  battery: 100,
  position: { x: 0, y: 0 },
  ...overrides,
});

/** Fires a socket event exactly as the realtime client would. */
function fire(event, payload) {
  act(() => {
    socketHandlers.current[event]?.(payload);
  });
}

function mockSnapshot({ robots = [], orders = [], obstacles = [] } = {}) {
  api.listRobots.mockResolvedValue({ data: robots });
  api.listOrders.mockResolvedValue({ data: orders });
  api.listObstacles.mockResolvedValue({ data: obstacles });
}

describe('useLiveSimulation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketHandlers.current = {};
    realtimeState.current = { status: 'connected', attempts: 0, error: null };
    realtime.isConnected.mockReturnValue(true);
    realtime.emit.mockReturnValue(true);
    mockSnapshot();
  });

  describe('loading', () => {
    it('does nothing at all without a warehouse', () => {
      const { result } = renderHook(() => useLiveSimulation(null, GRID));

      expect(result.current.phase).toBe(SIMULATION_PHASE.IDLE);
      expect(api.listRobots).not.toHaveBeenCalled();
      expect(realtime.joinWarehouse).not.toHaveBeenCalled();
      expect(result.current.isStale).toBe(false);
    });

    it('loads a snapshot and joins the room for a warehouse', async () => {
      mockSnapshot({ robots: [robot('r1')], orders: [{ _id: 'o1', status: 'pending' }] });

      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));

      expect(result.current.isLoading).toBe(true);
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));

      expect(result.current.robots).toHaveLength(1);
      expect(result.current.orders).toHaveLength(1);
      expect(realtime.joinWarehouse).toHaveBeenCalledWith(WAREHOUSE);
    });

    it('reports a readable error when the first load fails', async () => {
      api.listRobots.mockRejectedValue(Object.assign(new Error('Request failed: 500'), { status: 500 }));

      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));

      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.ERROR));
      expect(result.current.actionError).toMatch(/unexpected error/i);
    });

    it('leaves the room and removes its listeners on unmount', () => {
      const leave = vi.fn();
      realtime.joinWarehouse.mockReturnValue(leave);

      const { unmount } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      expect(Object.keys(socketHandlers.current).length).toBeGreaterThan(0);

      unmount();

      expect(leave).toHaveBeenCalled();
      expect(Object.keys(socketHandlers.current)).toEqual([]);
    });
  });

  describe('live updates', () => {
    it('folds a robots:changed event into the fleet', async () => {
      mockSnapshot({ robots: [robot('r1')] });
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.robots).toHaveLength(1));

      fire('robots:changed', {
        warehouseId: WAREHOUSE,
        robots: [{ id: 'r1', status: 'moving', position: { x: 3, y: 1 } }],
      });

      expect(result.current.robots[0].status).toBe('moving');
      expect(result.current.robotCounts.moving).toBe(1);
    });

    it('ignores events addressed to a different warehouse', async () => {
      mockSnapshot({ robots: [robot('r1')] });
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.robots).toHaveLength(1));

      fire('robots:changed', { warehouseId: 'someone-elses', robots: [robot('r9')] });

      expect(result.current.robots.map((r) => r.id)).toEqual(['r1']);
    });

    it('takes the run state from simulation:status, not from having asked', async () => {
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));

      act(() => result.current.startSimulation());
      expect(result.current.isRunning).toBe(true); // optimistic

      fire('simulation:status', { warehouseId: WAREHOUSE, running: false });

      expect(result.current.isRunning).toBe(false);
    });

    it('applies an obstacles:changed list directly', async () => {
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));

      fire('obstacles:changed', {
        warehouseId: WAREHOUSE,
        obstacles: [{ id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 1 }] }],
      });

      expect(result.current.obstacles).toHaveLength(1);
    });

    it('collects notifications newest-first and lets them be dismissed', async () => {
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));

      fire('notification', { warehouseId: WAREHOUSE, message: 'first', level: 'info', timestamp: 1 });
      fire('notification', { warehouseId: WAREHOUSE, message: 'second', level: 'warn', timestamp: 2 });

      expect(result.current.notifications.map((n) => n.message)).toEqual(['second', 'first']);

      act(() => result.current.dismissNotification(result.current.notifications[0].id));
      expect(result.current.notifications.map((n) => n.message)).toEqual(['first']);
    });

    it('clears the view when the warehouse is deleted out from under it', async () => {
      mockSnapshot({ robots: [robot('r1')] });
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.robots).toHaveLength(1));

      fire('warehouse:deleted', { warehouseId: WAREHOUSE });

      expect(result.current.robots).toEqual([]);
      expect(result.current.actionError).toMatch(/deleted/i);
    });
  });

  describe('reconnect and resync', () => {
    it('replaces local state with the server snapshot on simulation:sync', async () => {
      mockSnapshot({ robots: [robot('r1'), robot('r2')] });
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.robots).toHaveLength(2));

      // r1 was deleted while this client was disconnected. No future event
      // will ever mention it again, so only a replace can drop it.
      fire('simulation:sync', {
        warehouseId: WAREHOUSE,
        robots: [robot('r2', { position: { x: 4, y: 4 } })],
        obstacles: [],
        running: true,
      });

      expect(result.current.robots.map((r) => r.id)).toEqual(['r2']);
      expect(result.current.isRunning).toBe(true);
    });

    it('refetches orders once for a burst of orders:changed invalidations', async () => {
      vi.useFakeTimers();
      try {
        mockSnapshot();
        const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(result.current.phase).toBe(SIMULATION_PHASE.READY);
        api.listOrders.mockClear();
        api.listOrders.mockResolvedValue({ data: [{ _id: 'o1', status: 'pending' }] });

        // A dispatch moves several orders at once; the server emits one
        // event per change. Without coalescing that is one REST round trip
        // each, several times a second, for a signal that carries no data.
        fire('orders:changed', { warehouseId: WAREHOUSE });
        fire('orders:changed', { warehouseId: WAREHOUSE });
        fire('orders:changed', { warehouseId: WAREHOUSE });

        expect(api.listOrders).not.toHaveBeenCalled();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(300);
        });

        expect(api.listOrders).toHaveBeenCalledTimes(1);
        expect(result.current.orders).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('marks data stale even when the first load failed', async () => {
      // The case this used to miss entirely: the network dies during the
      // initial fetch, so the panel shows an empty warehouse. That is when
      // "this is not live" matters most, not least.
      api.listRobots.mockRejectedValue(Object.assign(new Error('Network request failed'), { status: 0 }));
      const { result, rerender } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.ERROR));

      realtimeState.current = { status: 'reconnecting', attempts: 1, error: null };
      rerender();

      expect(result.current.isStale).toBe(true);
    });

    it('is not stale merely because it is still loading', async () => {
      realtimeState.current = { status: 'reconnecting', attempts: 1, error: null };
      api.listRobots.mockReturnValue(new Promise(() => {}));
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));

      expect(result.current.isLoading).toBe(true);
      expect(result.current.isStale).toBe(false);
    });

    it('marks data stale while the live connection is down', async () => {
      const { result, rerender } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));
      expect(result.current.isStale).toBe(false);

      realtimeState.current = { status: 'reconnecting', attempts: 2, error: null };
      rerender();

      expect(result.current.isStale).toBe(true);
      expect(result.current.canControl).toBe(false);
    });
  });

  describe('races', () => {
    it('drops a snapshot that resolves after the warehouse changed', async () => {
      let resolveFirst;
      api.listRobots.mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; })
      );
      api.listOrders.mockResolvedValue({ data: [] });
      api.listObstacles.mockResolvedValue({ data: [] });

      const { result, rerender } = renderHook(({ id }) => useLiveSimulation(id, GRID), {
        initialProps: { id: 'w1' },
      });

      // Switch warehouses while w1's snapshot is still in flight, then let
      // it land. Its robots belong to a warehouse nobody is looking at.
      mockSnapshot({ robots: [robot('r-new')] });
      rerender({ id: 'w2' });
      await act(async () => {
        resolveFirst({ data: [robot('r-old')] });
      });

      await waitFor(() => expect(result.current.robots.map((r) => r.id)).toEqual(['r-new']));
    });
  });

  describe('commands', () => {
    it('refuses to send a start while disconnected, and says why', async () => {
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));
      realtime.isConnected.mockReturnValue(false);

      act(() => result.current.startSimulation());

      // socket.io would happily buffer this and deliver it on reconnect,
      // minutes later. Refusing and saying so is the honest behaviour.
      expect(realtime.emit).not.toHaveBeenCalled();
      expect(result.current.isRunning).toBe(false);
      expect(result.current.actionError).toMatch(/not connected/i);
    });

    it('emits start with the tick delta the server expects', async () => {
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));

      act(() => result.current.startSimulation());

      expect(realtime.emit).toHaveBeenCalledWith('simulation:start', {
        warehouseId: WAREHOUSE,
        deltaSeconds: 0.5,
        // A simulation is normally a thing being watched, and stops when
        // the last watcher leaves. Starting one is not, by default, asking
        // for a background job.
        background: false,
      });
    });

    it('asks the server to keep running unattended when that is what was chosen', async () => {
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));

      act(() => result.current.startSimulation({ background: true }));

      expect(realtime.emit).toHaveBeenCalledWith(
        'simulation:start',
        expect.objectContaining({ background: true })
      );
    });

    it('surfaces a server-refused socket command and undoes the optimistic start', async () => {
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));
      act(() => result.current.startSimulation());
      expect(result.current.isRunning).toBe(true);

      fire('error:unauthorized', { event: 'simulation:start', message: 'Warehouse not found' });

      expect(result.current.isRunning).toBe(false);
      expect(result.current.actionError).toBe('Warehouse not found');
    });

    it('reports a rate limit rather than looking like nothing happened', async () => {
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));

      fire('error:rate_limit', { event: 'warehouse:join', message: 'Rate limit exceeded for this event.' });

      expect(result.current.actionError).toMatch(/rate limit/i);
    });

    it('marks a command pending while it is in flight', async () => {
      let resolveSpawn;
      api.spawnRobot.mockReturnValue(new Promise((resolve) => { resolveSpawn = resolve; }));
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));

      let pending;
      act(() => {
        pending = result.current.spawnRandomRobot();
      });
      await waitFor(() => expect(result.current.pendingAction).toBe('spawn'));

      await act(async () => {
        resolveSpawn({ id: 'r1' });
        await pending;
      });

      expect(result.current.pendingAction).toBeNull();
    });

    it('turns a failed command into one readable sentence', async () => {
      api.generateOrders.mockRejectedValue(
        Object.assign(new Error('Too many requests'), { status: 429 })
      );
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));

      await act(async () => {
        await result.current.generateOrders(5);
      });

      expect(result.current.actionError).toBe('Too many requests');
      expect(result.current.pendingAction).toBeNull();
    });

    it('refuses to spawn onto a grid with no walkable cells', async () => {
      const fullGrid = {
        rows: 2,
        cols: 2,
        cells: new Map([
          ['0:0', 'shelf'],
          ['1:0', 'shelf'],
          ['0:1', 'shelf'],
          ['1:1', 'shelf'],
        ]),
      };
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, fullGrid));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));

      await act(async () => {
        await result.current.spawnRandomRobot();
      });

      expect(api.spawnRobot).not.toHaveBeenCalled();
      expect(result.current.actionError).toMatch(/no walkable cells/i);
    });

    it('places an obstacle through the API rather than inventing local state', async () => {
      api.addObstacle.mockResolvedValue({ id: 'o1' });
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.phase).toBe(SIMULATION_PHASE.READY));

      await act(async () => {
        await result.current.addObstacle({ id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 1 }] });
      });

      expect(api.addObstacle).toHaveBeenCalledWith(WAREHOUSE, expect.objectContaining({ id: 'o1' }));
      // The obstacles:changed broadcast is what updates state - the command
      // deliberately does not write it locally.
      expect(result.current.obstacles).toEqual([]);
    });
  });

  describe('derived client state', () => {
    it('accumulates a heatmap without replacing the Map on every update', async () => {
      mockSnapshot({ robots: [robot('r1', { position: { x: 2, y: 3 } })] });
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.robots).toHaveLength(1));

      const firstMap = result.current.heatmap;
      fire('robots:changed', { warehouseId: WAREHOUSE, robots: [{ id: 'r1', position: { x: 2, y: 3 } }] });

      expect(result.current.heatmap).toBe(firstMap); // same object, mutated
      expect(result.current.heatmap.get('2:3')).toBeGreaterThan(1);
    });

    it('clearing the heatmap swaps the Map and bumps the epoch so the canvas redraws', async () => {
      mockSnapshot({ robots: [robot('r1', { position: { x: 1, y: 1 } })] });
      const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
      await waitFor(() => expect(result.current.heatmap.size).toBe(1));
      const epochBefore = result.current.heatmapEpoch;

      act(() => result.current.clearHeatmap());

      expect(result.current.heatmap.size).toBe(0);
      expect(result.current.heatmapEpoch).toBeGreaterThan(epochBefore);
    });

    it('samples chart history on a timer, not on every robot update', async () => {
      vi.useFakeTimers();
      try {
        mockSnapshot({ robots: [robot('r1', { status: 'moving' })] });
        const { result } = renderHook(() => useLiveSimulation(WAREHOUSE, GRID));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        fire('simulation:status', { warehouseId: WAREHOUSE, running: true });
        expect(result.current.history).toHaveLength(1); // one immediate sample

        // Twenty robot updates inside one second must not become twenty
        // chart points on an axis that claims to be in seconds.
        for (let i = 0; i < 20; i += 1) {
          fire('robots:changed', {
            warehouseId: WAREHOUSE,
            robots: [{ id: 'r1', position: { x: i % 5, y: 0 } }],
          });
        }
        expect(result.current.history).toHaveLength(1);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        expect(result.current.history).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

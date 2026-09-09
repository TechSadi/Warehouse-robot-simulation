import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  listRobots,
  listOrders,
  listObstacles,
  spawnRobot as apiSpawnRobot,
  generateOrders as apiGenerateOrders,
  dispatchOrders as apiDispatchOrders,
  addObstacle as apiAddObstacle,
  removeObstacle as apiRemoveObstacle,
} from '../api/client.js';
import { describeError } from '../api/errors.js';
import { realtime } from '../api/realtime.js';
import { setTelemetryWarehouse } from '../api/telemetry.js';
import { useRealtimeStatus, isLive } from './useConnection.js';
import {
  simulationReducer,
  INITIAL_SERVER_STATE,
  summarizeOrders,
  summarizeRobots,
  utilizationOf,
} from './simulationReducer.js';

const TICK_DELTA_SECONDS = 0.5;
/** One chart point per second, for one minute of history. */
const HISTORY_SAMPLE_MS = 1000;
const MAX_HISTORY_POINTS = 60;
const MAX_NOTIFICATIONS = 20;

/**
 * Several `orders:changed` events can land inside a single tick - the
 * server emits one whenever an order's status moves, and a dispatch moves
 * several at once. Each is only an invalidation signal, so collapsing a
 * burst into one refetch turns a request-per-event storm into a request per
 * quarter second, without ever showing older data than the last event
 * describes.
 */
const ORDERS_REFETCH_DEBOUNCE_MS = 250;

export const SIMULATION_PHASE = {
  /** No warehouse selected - nothing to load. */
  IDLE: 'idle',
  /** First snapshot for this warehouse is in flight. */
  LOADING: 'loading',
  READY: 'ready',
  /** The first load failed; there is nothing to show. */
  ERROR: 'error',
};

/**
 * The live view of one warehouse: its robots, orders, obstacles, and
 * whether its simulation is running.
 *
 * State here is deliberately split in three, because conflating them is
 * what made the previous version hard to reason about:
 *
 *  - **Server state** (`simulationReducer.js`) - mirrored from the server,
 *    never invented locally.
 *  - **Derived state** - counts, averages, utilisation. Computed from
 *    server state on render rather than stored, so it can never disagree
 *    with what it was derived from.
 *  - **Client state** - the chart history, the traffic heatmap, the
 *    notification feed, the last action error. These exist only here and
 *    are cleared when the warehouse changes.
 *
 * Transport-wise: joining a warehouse's room fetches one REST snapshot so
 * the view has data even with the socket down, then every subsequent update
 * arrives as a socket event. Rejoining rooms after a reconnect is the
 * realtime client's job, not this hook's - see api/realtime.js.
 */
export function useLiveSimulation(warehouseId, grid) {
  const [server, dispatch] = useReducer(simulationReducer, INITIAL_SERVER_STATE);
  const [phase, setPhase] = useState(SIMULATION_PHASE.IDLE);
  const [actionError, setActionError] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [history, setHistory] = useState([]);
  /** Names an action currently in flight ('spawn' | 'orders' | 'dispatch'),
   * so its button can show progress and refuse a second click. */
  const [pendingAction, setPendingAction] = useState(null);

  const connection = useRealtimeStatus();
  const live = isLive(connection);

  /**
   * Traffic heatmap. Held in a ref and mutated in place rather than kept in
   * state: it is redrawn by the canvas, which already redraws whenever
   * `robots` changes, so copying the whole Map into new state twice a
   * second bought nothing but garbage and a render.
   */
  const heatmapRef = useRef(new Map());
  /** Bumped when the heatmap is cleared, so consumers that memoise on it
   * still see a wipe. Ordinary accumulation needs no version - the robot
   * update that caused it already triggers the redraw. */
  const [heatmapEpoch, setHeatmapEpoch] = useState(0);

  const requestSeq = useRef(0);
  const ordersTimer = useRef(null);
  const latestRef = useRef({ robots: [], orders: [] });
  latestRef.current = { robots: server.robots, orders: server.orders };

  const reportError = useCallback((err) => {
    setActionError(describeError(err));
  }, []);

  const dismissActionError = useCallback(() => setActionError(null), []);

  // --- Server state loading ------------------------------------------------

  /**
   * Refetches just the orders. Guarded by a sequence number so a slow
   * response for a warehouse (or an invalidation) the user has already
   * moved on from cannot overwrite fresher state - the classic async race
   * that shows a previous warehouse's orders after switching.
   */
  const refreshOrders = useCallback(async (id, seq, signal) => {
    try {
      const res = await listOrders(id, {}, { signal });
      if (seq !== requestSeq.current) return;
      dispatch({ type: 'orders/loaded', orders: res.data || [], at: Date.now() });
    } catch (err) {
      if (err?.name === 'AbortError' || seq !== requestSeq.current) return;
      reportError(err);
    }
  }, [reportError]);

  // --- Room membership, socket listeners, initial snapshot -----------------

  useEffect(() => {
    // Invalidate anything still in flight for the previous warehouse.
    requestSeq.current += 1;
    const seq = requestSeq.current;

    if (ordersTimer.current) {
      clearTimeout(ordersTimer.current);
      ordersTimer.current = null;
    }

    dispatch({ type: 'reset' });
    setHistory([]);
    setActionError(null);
    heatmapRef.current = new Map();
    setHeatmapEpoch((epoch) => epoch + 1);

    // So a client error report lands in the log of the warehouse the
    // operator was actually watching when it happened - see
    // api/telemetry.js. Cleared below when there is no warehouse.
    setTelemetryWarehouse(warehouseId);

    if (!warehouseId) {
      setPhase(SIMULATION_PHASE.IDLE);
      return undefined;
    }

    setPhase(SIMULATION_PHASE.LOADING);

    const controller = new AbortController();
    const { signal } = controller;

    function belongsHere(payload) {
      return String(payload?.warehouseId) === String(warehouseId);
    }

    /** Collapses a burst of `orders:changed` events into one refetch. */
    function scheduleOrdersRefresh() {
      if (ordersTimer.current) return;
      ordersTimer.current = setTimeout(() => {
        ordersTimer.current = null;
        refreshOrders(warehouseId, seq, signal);
      }, ORDERS_REFETCH_DEBOUNCE_MS);
    }

    // One registration object, one teardown function. The previous version
    // listed fourteen `socket.on` calls and fourteen `socket.off` calls by
    // hand, where a single mismatch leaks a listener on every remount.
    const unsubscribe = realtime.on({
      'robots:changed': (payload) => {
        if (!belongsHere(payload)) return;
        dispatch({ type: 'robots/changed', robots: payload.robots, at: Date.now() });
      },
      'robots:removed': (payload) => {
        if (!belongsHere(payload)) return;
        dispatch({ type: 'robots/removed', robotId: payload.robotId, at: Date.now() });
      },
      'orders:changed': (payload) => {
        if (!belongsHere(payload)) return;
        scheduleOrdersRefresh();
      },
      'obstacles:changed': (payload) => {
        if (!belongsHere(payload)) return;
        dispatch({ type: 'obstacles/changed', obstacles: payload.obstacles, at: Date.now() });
      },
      notification: (payload) => {
        if (!belongsHere(payload)) return;
        const id = `${payload.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNotifications((prev) => [{ ...payload, id }, ...prev].slice(0, MAX_NOTIFICATIONS));
      },
      'simulation:status': (payload) => {
        if (!belongsHere(payload)) return;
        dispatch({ type: 'simulation/status', running: payload.running });
      },
      'simulation:sync': (payload) => {
        if (!belongsHere(payload)) return;
        dispatch({
          type: 'sync',
          robots: payload.robots,
          obstacles: payload.obstacles,
          running: payload.running,
          at: Date.now(),
        });
        setPhase(SIMULATION_PHASE.READY);
        setActionError(null);
      },
      'warehouse:deleted': (payload) => {
        if (!belongsHere(payload)) return;
        dispatch({ type: 'warehouse/deleted' });
        setActionError('This warehouse was deleted.');
      },
      // The server refuses socket events it will not serve - a warehouse
      // the caller does not own, a malformed payload, or too many events
      // too fast. These arrive as events rather than as a failed promise
      // (an emit has nothing to reject), so without a listener the UI would
      // sit there looking like nothing had happened at all.
      'error:unauthorized': handleSocketError,
      'error:validation': handleSocketError,
      'error:rate_limit': handleSocketError,
      'error:server': handleSocketError,
    });

    function handleSocketError(payload) {
      setActionError(payload?.message || 'The server refused that request.');
      // A refused start never started anything; correct the optimistic flip.
      if (payload?.event === 'simulation:start') {
        dispatch({ type: 'simulation/status', running: false });
      }
    }

    // Registering the room is what makes the connection layer rejoin it
    // after every reconnect, for as long as this view is mounted.
    const leaveRoom = realtime.joinWarehouse(warehouseId);

    // One REST snapshot so the dashboard is populated even if the socket is
    // down. If a socket sync lands first the reducer keeps the newer one.
    Promise.all([
      listRobots(warehouseId, { signal }),
      listOrders(warehouseId, {}, { signal }),
      listObstacles(warehouseId, { signal }),
    ])
      .then(([robotsRes, ordersRes, obstaclesRes]) => {
        if (seq !== requestSeq.current) return;
        dispatch({
          type: 'snapshot',
          robots: robotsRes.data || [],
          orders: ordersRes.data || [],
          obstacles: obstaclesRes.data || [],
          at: Date.now(),
        });
        setPhase(SIMULATION_PHASE.READY);
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || seq !== requestSeq.current) return;
        reportError(err);
        setPhase(SIMULATION_PHASE.ERROR);
      });

    return () => {
      controller.abort();
      if (ordersTimer.current) {
        clearTimeout(ordersTimer.current);
        ordersTimer.current = null;
      }
      unsubscribe();
      leaveRoom();
    };
  }, [warehouseId, refreshOrders, reportError]);

  // --- Client-side derived history ----------------------------------------

  /**
   * Samples the fleet once a second while the simulation runs.
   *
   * This used to append a point inside an effect keyed on `robots`/`orders`,
   * which fired on every tick event - twice a second at the default cadence,
   * and more under a burst - so the "60 points = one minute" window was
   * really about twenty seconds, several points shared an identical `t`, and
   * every one of them re-rendered the chart. A timer samples the thing the
   * chart's x-axis actually claims to measure.
   */
  useEffect(() => {
    if (!server.isRunning) return undefined;

    const startedAt = Date.now();
    setHistory([]);

    function sample() {
      const { robots, orders } = latestRef.current;
      const { counts } = summarizeRobots(robots);
      const orderCounts = summarizeOrders(orders);
      const point = {
        t: Math.round((Date.now() - startedAt) / 1000),
        active: counts.moving + counts.charging,
        delivered: orderCounts.delivered,
      };
      setHistory((prev) => {
        const next = [...prev, point];
        return next.length > MAX_HISTORY_POINTS ? next.slice(-MAX_HISTORY_POINTS) : next;
      });
    }

    sample();
    const interval = setInterval(sample, HISTORY_SAMPLE_MS);
    return () => clearInterval(interval);
  }, [server.isRunning]);

  // Accumulate heatmap visits. Mutating the ref in place is deliberate -
  // see the note on heatmapRef above.
  useEffect(() => {
    if (server.robots.length === 0) return;
    const heatmap = heatmapRef.current;
    for (const robot of server.robots) {
      const key = `${Math.round(robot.position.x)}:${Math.round(robot.position.y)}`;
      heatmap.set(key, (heatmap.get(key) || 0) + 1);
    }
  }, [server.robots]);

  const clearHeatmap = useCallback(() => {
    heatmapRef.current = new Map();
    setHeatmapEpoch((epoch) => epoch + 1);
  }, []);

  // --- Commands ------------------------------------------------------------

  /** Socket commands are only meaningful while the socket is up. socket.io
   * would otherwise buffer them and deliver on reconnect - a "start" clicked
   * during an outage firing minutes later, long after the person gave up. */
  const requireLive = useCallback(() => {
    if (realtime.isConnected()) return true;
    setActionError('Not connected to the simulation server. Reconnecting - try again in a moment.');
    return false;
  }, []);

  /**
   * @param {{background?: boolean}} [options] `background: true` asks the
   *   server to keep the simulation running once the last watcher leaves.
   *   Off by default, because the default reading of "start" is "start,
   *   while I watch" - and a run nobody is watching still costs a tick
   *   loop, a pinned engine and a stream of writes. The server bounds how
   *   long an unattended run may last (MAX_BACKGROUND_SECONDS).
   */
  const startSimulation = useCallback(
    (options = {}) => {
      if (!warehouseId || !requireLive()) return;
      setActionError(null);
      // Optimistic; `simulation:status` confirms or corrects it within a tick.
      dispatch({ type: 'simulation/optimistic', running: true });
      realtime.emit('simulation:start', {
        warehouseId,
        deltaSeconds: TICK_DELTA_SECONDS,
        background: Boolean(options.background),
      });
    },
    [warehouseId, requireLive]
  );

  const stopSimulation = useCallback(() => {
    if (!warehouseId || !requireLive()) return;
    setActionError(null);
    dispatch({ type: 'simulation/optimistic', running: false });
    realtime.emit('simulation:stop', { warehouseId });
  }, [warehouseId, requireLive]);

  /** Runs an API command with one shared shape: mark it pending, surface
   * any failure as one readable sentence, always clear the pending flag.
   * Six copies of this try/catch had drifted apart before. */
  const runCommand = useCallback(
    async (name, fn) => {
      setPendingAction(name);
      setActionError(null);
      try {
        return await fn();
      } catch (err) {
        reportError(err);
        return null;
      } finally {
        setPendingAction(null);
      }
    },
    [reportError]
  );

  const spawnRobotAt = useCallback(
    (position) => {
      if (!warehouseId) return null;
      // No manual refresh needed - the resulting robots:changed event
      // (emitted server-side from robot.controller.js) updates state.
      return runCommand('spawn', () =>
        apiSpawnRobot({
          warehouseId,
          position,
          name: `Robot ${latestRef.current.robots.length + 1}`,
        })
      );
    },
    [warehouseId, runCommand]
  );

  const spawnRandomRobot = useCallback(async () => {
    const walkable = [];
    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.cols; x++) {
        if (!grid.cells.has(`${x}:${y}`)) walkable.push({ x, y });
      }
    }
    if (walkable.length === 0) {
      setActionError('No walkable cells to spawn a robot on. Clear some shelves or obstacles first.');
      return null;
    }
    const occupied = new Set(
      latestRef.current.robots.map((r) => `${Math.round(r.position.x)}:${Math.round(r.position.y)}`)
    );
    const free = walkable.filter((cell) => !occupied.has(`${cell.x}:${cell.y}`));
    const pool = free.length > 0 ? free : walkable;
    return spawnRobotAt(pool[Math.floor(Math.random() * pool.length)]);
  }, [grid, spawnRobotAt]);

  const generateOrders = useCallback(
    (count) => {
      if (!warehouseId) return null;
      return runCommand('orders', () => apiGenerateOrders(warehouseId, count));
    },
    [warehouseId, runCommand]
  );

  const dispatchNow = useCallback(() => {
    if (!warehouseId) return null;
    return runCommand('dispatch', () => apiDispatchOrders(warehouseId));
  }, [warehouseId, runCommand]);

  const addObstacle = useCallback(
    (payload) => {
      if (!warehouseId) return null;
      return runCommand('obstacle', () => apiAddObstacle(warehouseId, payload));
    },
    [warehouseId, runCommand]
  );

  const removeObstacle = useCallback(
    (obstacleId) => {
      if (!warehouseId) return null;
      return runCommand('obstacle', () => apiRemoveObstacle(warehouseId, obstacleId));
    },
    [warehouseId, runCommand]
  );

  const dismissNotification = useCallback((id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clearNotifications = useCallback(() => setNotifications([]), []);

  // --- Derived state -------------------------------------------------------

  const fleet = useMemo(() => summarizeRobots(server.robots), [server.robots]);
  const orderCounts = useMemo(() => summarizeOrders(server.orders), [server.orders]);
  const utilizationPercent = useMemo(
    () => utilizationOf(fleet.counts, fleet.total),
    [fleet.counts, fleet.total]
  );

  return {
    // Server state
    robots: server.robots,
    orders: server.orders,
    obstacles: server.obstacles,
    isRunning: server.isRunning,
    syncedAt: server.syncedAt,
    warehouseDeleted: server.deleted,

    // Loading / connection
    phase,
    isLoading: phase === SIMULATION_PHASE.LOADING,
    /**
     * What is on screen is not the current state of the fleet.
     *
     * Deliberately not "loaded successfully and then went offline": this
     * used to require phase READY, which meant the one case where the
     * warning matters most - the network dying *during* the first load, so
     * the panel shows an empty warehouse - was the one case it stayed
     * silent for. Anything other than "nothing selected" or "still
     * loading" is a view that cannot be trusted while the channel is down.
     */
    isStale:
      Boolean(warehouseId) &&
      !live &&
      phase !== SIMULATION_PHASE.IDLE &&
      phase !== SIMULATION_PHASE.LOADING,
    connection,
    canControl: live,

    // Derived
    robotCounts: fleet.counts,
    avgBattery: fleet.avgBattery,
    lowBatteryCount: fleet.lowBattery,
    orderCounts,
    utilizationPercent,

    // Client state
    history,
    heatmap: heatmapRef.current,
    heatmapEpoch,
    clearHeatmap,
    notifications,
    dismissNotification,
    clearNotifications,
    actionError,
    dismissActionError,
    pendingAction,

    // Commands
    startSimulation,
    stopSimulation,
    spawnRandomRobot,
    generateOrders,
    dispatchNow,
    addObstacle,
    removeObstacle,
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listRobots,
  listOrders,
  listObstacles,
  spawnRobot as apiSpawnRobot,
  generateOrders as apiGenerateOrders,
  dispatchOrders as apiDispatchOrders,
} from '../api/client.js';
import { socket } from '../api/socket.js';

const TICK_INTERVAL_MS = 500;
const TICK_DELTA_SECONDS = TICK_INTERVAL_MS / 1000;
const MAX_HISTORY_POINTS = 60; // 1 minute of history at 1 point/second
const MAX_NOTIFICATIONS = 20;

const ORDER_STATUSES = ['pending', 'assigned', 'picked_up', 'delivered', 'cancelled'];

function summarizeOrders(orders) {
  const counts = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  for (const order of orders) counts[order.status] = (counts[order.status] || 0) + 1;
  return counts;
}

function summarizeRobots(robots) {
  const counts = { idle: 0, moving: 0, charging: 0, error: 0 };
  let batterySum = 0;
  for (const robot of robots) {
    counts[robot.status] = (counts[robot.status] || 0) + 1;
    batterySum += robot.battery;
  }
  const avgBattery = robots.length > 0 ? batterySum / robots.length : 0;
  return { counts, avgBattery };
}

/** Upserts `updates` into `list` by `id` - used to fold a robots:changed
 * event's (possibly partial) set of changed robots into existing state
 * without dropping robots the event didn't mention. */
function mergeById(list, updates) {
  if (!updates || updates.length === 0) return list;
  const byId = new Map(list.map((item) => [item.id, item]));
  for (const update of updates) byId.set(update.id, { ...byId.get(update.id), ...update });
  return Array.from(byId.values());
}

/**
 * Milestone 11: the live view of a synced warehouse's robots/orders/
 * obstacles is now push-driven over Socket.IO instead of Milestone 10's
 * client-side polling plus a client-owned tick `setInterval`. Joining a
 * warehouse's room fetches one authoritative REST snapshot, then every
 * subsequent update arrives as a `robots:changed` / `robots:removed` /
 * `orders:changed` / `obstacles:changed` / `notification` event broadcast
 * from the server - see backend/src/sockets/index.js.
 *
 * `orders:changed` deliberately carries just enough to know *something*
 * changed rather than a full diff - order documents have more fields than
 * a tick event does, so reconstructing them client-side would be fragile.
 * It's treated as an invalidation signal that triggers one targeted
 * re-fetch, not a state patch. `obstacles:changed`, by contrast, always
 * carries the full current obstacle list (there are never many), so it's
 * applied directly.
 *
 * The simulation start/stop loop itself now runs on the server
 * (tickLoopManager.js), shared by every client watching this warehouse -
 * it keeps advancing for everyone else even if whoever clicked Start later
 * navigates away, so this hook no longer stops it on unmount the way
 * Milestone 10's client-owned interval did. `simulation:status` is what
 * tells this hook whether the simulation is actually running, rather than
 * the hook assuming so just because it made the start call.
 */
export function useLiveSimulation(warehouseId, grid) {
  const [robots, setRobots] = useState([]);
  const [orders, setOrders] = useState([]);
  const [obstacles, setObstacles] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [history, setHistory] = useState([]);
  const [heatmap, setHeatmap] = useState(() => new Map());
  const [actionError, setActionError] = useState(null);

  const startTimeRef = useRef(null);

  const refreshSnapshot = useCallback(async (id) => {
    if (!id) return;
    try {
      const [robotsRes, ordersRes, obstaclesRes] = await Promise.all([
        listRobots(id),
        listOrders(id),
        listObstacles(id),
      ]);
      setRobots(robotsRes.data || []);
      setOrders(ordersRes.data || []);
      setObstacles(obstaclesRes.data || []);
      setActionError(null);
    } catch (err) {
      setActionError(err.message);
    }
  }, []);

  // Join/leave the warehouse's Socket.IO room as the synced warehouse
  // changes, fetch one initial snapshot, and wire up real-time listeners
  // for the rest of this warehouse's lifetime in view.
  useEffect(() => {
    if (!warehouseId) {
      setRobots([]);
      setOrders([]);
      setObstacles([]);
      setHistory([]);
      setHeatmap(new Map());
      setIsRunning(false);
      return undefined;
    }

    startTimeRef.current = Date.now();
    setHistory([]);
    setHeatmap(new Map());
    socket.emit('warehouse:join', warehouseId);
    refreshSnapshot(warehouseId);

    function belongsHere(payload) {
      return String(payload?.warehouseId) === String(warehouseId);
    }

    function onRobotsChanged(payload) {
      if (!belongsHere(payload)) return;
      setRobots((prev) => mergeById(prev, payload.robots));
    }
    function onRobotsRemoved(payload) {
      if (!belongsHere(payload)) return;
      setRobots((prev) => prev.filter((r) => r.id !== payload.robotId));
    }
    function onOrdersChanged(payload) {
      if (!belongsHere(payload)) return;
      listOrders(warehouseId)
        .then((res) => setOrders(res.data || []))
        .catch((err) => setActionError(err.message));
    }
    function onObstaclesChanged(payload) {
      if (!belongsHere(payload)) return;
      setObstacles(payload.obstacles || []);
    }
    function onNotification(payload) {
      if (!belongsHere(payload)) return;
      const id = `${payload.timestamp || Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setNotifications((prev) => [{ ...payload, id }, ...prev].slice(0, MAX_NOTIFICATIONS));
    }
    function onSimulationStatus(payload) {
      if (!belongsHere(payload)) return;
      setIsRunning(Boolean(payload.running));
      if (payload.running && !startTimeRef.current) startTimeRef.current = Date.now();
    }
    // A reconnect drops Socket.IO room membership server-side and may have
    // missed events during the gap - rejoin and re-sync from a fresh REST
    // snapshot rather than trusting whatever state accumulated so far.
    function onReconnect() {
      socket.emit('warehouse:join', warehouseId);
      refreshSnapshot(warehouseId);
    }

    socket.on('robots:changed', onRobotsChanged);
    socket.on('robots:removed', onRobotsRemoved);
    socket.on('orders:changed', onOrdersChanged);
    socket.on('obstacles:changed', onObstaclesChanged);
    socket.on('notification', onNotification);
    socket.on('simulation:status', onSimulationStatus);
    socket.on('connect', onReconnect);

    return () => {
      socket.off('robots:changed', onRobotsChanged);
      socket.off('robots:removed', onRobotsRemoved);
      socket.off('orders:changed', onOrdersChanged);
      socket.off('obstacles:changed', onObstaclesChanged);
      socket.off('notification', onNotification);
      socket.off('simulation:status', onSimulationStatus);
      socket.off('connect', onReconnect);
      socket.emit('warehouse:leave', warehouseId);
    };
  }, [warehouseId, refreshSnapshot]);

  // Accumulate heatmap visits whenever robots update.
  useEffect(() => {
    if (robots.length === 0) return;
    setHeatmap((prev) => {
      const next = new Map(prev);
      for (const robot of robots) {
        const key = `${Math.round(robot.position.x)}:${Math.round(robot.position.y)}`;
        next.set(key, (next.get(key) || 0) + 1);
      }
      return next;
    });
  }, [robots]);

  useEffect(() => {
    const { counts: robotCounts } = summarizeRobots(robots);
    const orderCounts = summarizeOrders(orders);
    const elapsed = startTimeRef.current ? (Date.now() - startTimeRef.current) / 1000 : 0;

    setHistory((prev) => {
      const point = {
        t: Math.round(elapsed),
        active: robotCounts.moving + robotCounts.charging,
        delivered: orderCounts.delivered,
      };
      const next = [...prev, point];
      return next.length > MAX_HISTORY_POINTS ? next.slice(-MAX_HISTORY_POINTS) : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [robots, orders]);

  const startSimulation = useCallback(() => {
    if (!warehouseId) return;
    startTimeRef.current = Date.now();
    setHistory([]);
    setIsRunning(true); // optimistic - simulation:status confirms/corrects this shortly
    socket.emit('simulation:start', { warehouseId, deltaSeconds: TICK_DELTA_SECONDS });
  }, [warehouseId]);

  const stopSimulation = useCallback(() => {
    if (!warehouseId) return;
    setIsRunning(false); // optimistic
    socket.emit('simulation:stop', { warehouseId });
  }, [warehouseId]);

  const spawnRobotAt = useCallback(
    async (position) => {
      if (!warehouseId) return;
      try {
        // No manual refresh needed - the resulting robots:changed event
        // (emitted server-side from robot.controller.js) updates state.
        await apiSpawnRobot({ warehouseId, position, name: `Robot ${robots.length + 1}` });
      } catch (err) {
        setActionError(err.message);
      }
    },
    [warehouseId, robots.length]
  );

  const spawnRandomRobot = useCallback(async () => {
    const walkable = [];
    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.cols; x++) {
        const key = `${x}:${y}`;
        if (!grid.cells.has(key)) walkable.push({ x, y });
      }
    }
    if (walkable.length === 0) {
      setActionError('No walkable cells to spawn a robot on');
      return;
    }
    const occupied = new Set(robots.map((r) => `${Math.round(r.position.x)}:${Math.round(r.position.y)}`));
    const free = walkable.filter((c) => !occupied.has(`${c.x}:${c.y}`));
    const pool = free.length > 0 ? free : walkable;
    const position = pool[Math.floor(Math.random() * pool.length)];
    await spawnRobotAt(position);
  }, [grid, robots, spawnRobotAt]);

  const generateOrders = useCallback(
    async (count) => {
      if (!warehouseId) return;
      try {
        await apiGenerateOrders(warehouseId, count);
      } catch (err) {
        setActionError(err.message);
      }
    },
    [warehouseId]
  );

  const dispatchNow = useCallback(async () => {
    if (!warehouseId) return;
    try {
      await apiDispatchOrders(warehouseId);
    } catch (err) {
      setActionError(err.message);
    }
  }, [warehouseId]);

  const dismissNotification = useCallback((id) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const { counts: robotCounts, avgBattery } = summarizeRobots(robots);
  const orderCounts = summarizeOrders(orders);
  const utilizationPercent = robots.length > 0 ? ((robotCounts.moving + robotCounts.charging) / robots.length) * 100 : 0;

  return {
    robots,
    orders,
    obstacles,
    notifications,
    robotCounts,
    orderCounts,
    avgBattery,
    utilizationPercent,
    history,
    heatmap,
    isRunning,
    startSimulation,
    stopSimulation,
    spawnRandomRobot,
    generateOrders,
    dispatchNow,
    actionError,
    dismissActionError: () => setActionError(null),
    dismissNotification,
  };
}

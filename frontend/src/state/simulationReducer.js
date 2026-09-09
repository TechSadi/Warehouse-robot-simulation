/**
 * Every mutation of *server-owned* simulation state, in one place.
 *
 * The distinction this file exists to draw: robots, orders, obstacles and
 * whether the simulation is running are facts the server owns. The client
 * does not get to decide them, only to mirror them. Everything else the
 * dashboard tracks - which cell is selected, whether the heatmap overlay is
 * on, how far the chart history goes back - is local UI state the server
 * has never heard of.
 *
 * They used to be nine `useState` calls side by side in one hook, updated
 * from a dozen socket callbacks, with no way to tell which ones a server
 * event was allowed to touch. Collecting the server half behind a reducer
 * makes the ownership explicit, makes every transition testable without a
 * socket or a React tree, and makes "can this event overwrite that field?"
 * a question with a single answer rather than a dozen.
 */

export const INITIAL_SERVER_STATE = {
  robots: [],
  orders: [],
  obstacles: [],
  isRunning: false,
  /** When the server last told us its authoritative view. Null until then,
   * which is what "we have never heard from the server" looks like - it is
   * not the same as "the server says there is nothing". */
  syncedAt: null,
  /** True once a socket-side `simulation:sync` has been applied. A REST
   * snapshot that resolves afterwards is older by definition and must not
   * overwrite it - see the `snapshot` case. */
  hasSocketSync: false,
  /** Set when the warehouse this view was watching stopped existing. */
  deleted: false,
};

/** Upserts `updates` into `list` by id - folds a `robots:changed` event's
 * (possibly partial) set of changed robots into existing state without
 * dropping robots the event did not mention. */
function mergeById(list, updates) {
  if (!Array.isArray(updates) || updates.length === 0) return list;
  const byId = new Map(list.map((item) => [item.id, item]));
  for (const update of updates) byId.set(update.id, { ...byId.get(update.id), ...update });
  return Array.from(byId.values());
}

export function simulationReducer(state, action) {
  switch (action.type) {
    case 'reset':
      return INITIAL_SERVER_STATE;

    /**
     * A REST snapshot (robots + orders + obstacles), fetched when a
     * warehouse is first opened so the view has data even if the socket is
     * still connecting or down entirely.
     *
     * Dropped once a socket sync has landed: the socket snapshot comes from
     * the live engine with sub-tick-accurate positions, while this one is
     * whatever Mongo held when the request was issued. Applying the older
     * one on top would visibly rewind every robot.
     */
    case 'snapshot':
      if (state.hasSocketSync) {
        // Orders are not part of a socket sync (the server sends an
        // invalidation instead), so that half is still the freshest we have.
        return { ...state, orders: action.orders ?? state.orders };
      }
      return {
        ...state,
        robots: action.robots ?? [],
        orders: action.orders ?? [],
        obstacles: action.obstacles ?? [],
        syncedAt: action.at,
      };

    /**
     * The server's authoritative view, sent on every room join and on
     * demand. Robots and obstacles are replaced outright rather than
     * merged: the point of a resync is that whatever this client
     * accumulated may be wrong, so folding the two together would preserve
     * exactly the stale entries it is meant to discard - a robot deleted
     * while we were disconnected, say, which no future `robots:changed`
     * event would ever mention again.
     */
    case 'sync':
      return {
        ...state,
        robots: action.robots ?? [],
        obstacles: action.obstacles ?? [],
        isRunning: Boolean(action.running),
        syncedAt: action.at,
        hasSocketSync: true,
        deleted: false,
      };

    case 'robots/changed':
      return { ...state, robots: mergeById(state.robots, action.robots), syncedAt: action.at };

    case 'robots/removed':
      return {
        ...state,
        robots: state.robots.filter((robot) => robot.id !== action.robotId),
        syncedAt: action.at,
      };

    /** Orders arrive only as whole lists from REST - `orders:changed` is an
     * invalidation signal, not a diff, because order documents carry more
     * fields than a socket event does and reconstructing them client-side
     * would be guesswork. */
    case 'orders/loaded':
      return { ...state, orders: action.orders ?? [], syncedAt: action.at };

    /** Obstacle events always carry the full current list (there are never
     * many), so unlike orders they can be applied directly. */
    case 'obstacles/changed':
      return { ...state, obstacles: action.obstacles ?? [], syncedAt: action.at };

    /** The server's `simulation:status`, which is what decides whether the
     * simulation is running - not the fact that this client asked for it. */
    case 'simulation/status':
      return { ...state, isRunning: Boolean(action.running) };

    /** Optimistic local flip while a start/stop command is in flight. Kept
     * separate from `simulation/status` so it is obvious in the transition
     * list which one the server confirmed and which one we guessed. */
    case 'simulation/optimistic':
      return { ...state, isRunning: Boolean(action.running) };

    /** The warehouse this view was watching was deleted by someone. Clear
     * rather than keep rendering a simulation that no longer exists. */
    case 'warehouse/deleted':
      return { ...INITIAL_SERVER_STATE, deleted: true };

    default:
      return state;
  }
}

const ORDER_STATUSES = ['pending', 'assigned', 'picked_up', 'delivered', 'cancelled'];
const ROBOT_STATUSES = ['idle', 'moving', 'charging', 'error'];

export function summarizeOrders(orders) {
  const counts = Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0]));
  for (const order of orders) counts[order.status] = (counts[order.status] || 0) + 1;
  return counts;
}

export function summarizeRobots(robots) {
  const counts = Object.fromEntries(ROBOT_STATUSES.map((status) => [status, 0]));
  let batterySum = 0;
  let lowBattery = 0;
  for (const robot of robots) {
    counts[robot.status] = (counts[robot.status] || 0) + 1;
    batterySum += robot.battery;
    if (robot.battery <= 20) lowBattery += 1;
  }
  return {
    counts,
    avgBattery: robots.length > 0 ? batterySum / robots.length : 0,
    lowBattery,
    total: robots.length,
  };
}

/** Share of the fleet doing something rather than sitting idle. */
export function utilizationOf(robotCounts, total) {
  if (!total) return 0;
  return ((robotCounts.moving + robotCounts.charging) / total) * 100;
}

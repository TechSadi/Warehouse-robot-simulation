const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// --- Order selectors: decide which pending order to consider next -------

const ORDER_SELECTORS = {
  /** Oldest order first - ignores priority entirely, on purpose. */
  fcfs(orders) {
    return [...orders].sort((a, b) => a.createdAt - b.createdAt);
  },
  /** Highest priority first; ties broken by age (oldest first). */
  priority(orders) {
    return [...orders].sort(
      (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt
    );
  },
};

// --- Robot selectors: decide which idle robot gets a given order --------
// Each takes (candidates, order, context) and returns one candidate or
// null. `context` carries state that must persist across calls for the
// strategies that need it (round robin's cursor, least-busy's completed
// counts) - everything else is a pure function of its arguments.

const ROBOT_SELECTORS = {
  /** Simplest possible choice: whichever candidate sorts first by id, for
   * deterministic behavior rather than true arbitrariness. */
  firstAvailable(candidates) {
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0];
  },

  /** Geometrically closest idle robot to the order's pickup point. */
  nearest(candidates, order) {
    if (candidates.length === 0) return null;
    return [...candidates].sort(
      (a, b) => distance(a.position, order.pickupLocation) - distance(b.position, order.pickupLocation)
    )[0];
  },

  /** The idle robot with the fewest orders it has completed so far this
   * session - spreads work evenly across the fleet rather than favoring
   * whichever robot happens to be positioned conveniently. */
  leastBusy(candidates, order, context) {
    if (candidates.length === 0) return null;
    const counts = context.completedCounts;
    return [...candidates].sort((a, b) => {
      const diff = (counts.get(a.id) || 0) - (counts.get(b.id) || 0);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    })[0];
  },

  /** Cycles through every robot in the warehouse in a fixed, stable order,
   * regardless of position or workload. Scans forward from the cursor
   * through the full roster (not just this pass's candidates) so fairness
   * holds even when some robots are busy and get skipped over. */
  roundRobin(candidates, order, context) {
    if (candidates.length === 0) return null;
    const roster = context.robotOrder;
    const n = roster.length;
    for (let i = 0; i < n; i++) {
      const idx = (context.cursor + i) % n;
      const candidate = candidates.find((c) => c.id === roster[idx]);
      if (candidate) {
        context.cursor = (idx + 1) % n;
        return candidate;
      }
    }
    return null;
  },
};

// --- The 5 named strategies the milestone asks for -----------------------

const STRATEGIES = {
  fcfs: { label: 'First Come First Serve', orderSelector: 'fcfs', robotSelector: 'firstAvailable' },
  nearest_robot: { label: 'Nearest Robot', orderSelector: 'fcfs', robotSelector: 'nearest' },
  least_busy: { label: 'Least Busy Robot', orderSelector: 'fcfs', robotSelector: 'leastBusy' },
  round_robin: { label: 'Round Robin', orderSelector: 'fcfs', robotSelector: 'roundRobin' },
  priority_queue: { label: 'Priority Queue', orderSelector: 'priority', robotSelector: 'nearest' },
};

const STRATEGY_KEYS = Object.keys(STRATEGIES);

/**
 * Pure assignment planner: given pending orders, all robots in the
 * warehouse, and a strategy name, returns the pairings to make -
 * `[{ orderId, robotId }, ...]` - without calling into the Robot Engine or
 * touching a database. The caller (orderService) is responsible for
 * actually executing the plan and persisting the results.
 *
 * `context` is mutated for strategies that need persistent state
 * (round robin's cursor) - pass the same context object across calls for a
 * given warehouse to get correct behavior, and a fresh one to reset it.
 */
function planAssignments({ strategyName, orders, robots, coordinator, context }) {
  const strategy = STRATEGIES[strategyName];
  if (!strategy) {
    throw new Error(`Unknown scheduling strategy "${strategyName}". Expected one of: ${STRATEGY_KEYS.join(', ')}`);
  }

  const orderSelect = ORDER_SELECTORS[strategy.orderSelector];
  const robotSelect = ROBOT_SELECTORS[strategy.robotSelector];
  const fullContext = { ...context, robotOrder: [...robots].map((r) => r.id).sort() };

  const takenRobotIds = new Set();
  const orderedOrders = orderSelect(orders);
  const plan = [];

  for (const order of orderedOrders) {
    const candidates = robots.filter(
      (r) => r.status === 'idle' && !takenRobotIds.has(r.id) && !coordinator.isRobotOnOrder(r.id)
    );
    if (candidates.length === 0) break; // no free robots left this pass

    const robot = robotSelect(candidates, order, fullContext);
    if (!robot) continue;

    takenRobotIds.add(robot.id);
    plan.push({ orderId: order.id, robotId: robot.id });
  }

  // Propagate any state mutation (e.g. round robin's cursor) back out.
  context.cursor = fullContext.cursor;

  return plan;
}

module.exports = { STRATEGIES, STRATEGY_KEYS, ORDER_SELECTORS, ROBOT_SELECTORS, planAssignments, PRIORITY_RANK };

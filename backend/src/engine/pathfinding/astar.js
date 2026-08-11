const PriorityQueue = require('./priorityQueue');
const { getHeuristic } = require('./heuristics');

const ORTHOGONAL_NEIGHBORS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
];

const DIAGONAL_NEIGHBORS = [
  { dx: 1, dy: -1 },
  { dx: 1, dy: 1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: -1 },
];

const STRAIGHT_COST = 1;
const DIAGONAL_COST = Math.SQRT2;

function key(x, y) {
  return `${x}:${y}`;
}

function inBounds(grid, x, y) {
  return x >= 0 && y >= 0 && x < grid.cols && y < grid.rows;
}

function isWalkable(grid, x, y) {
  return inBounds(grid, x, y) && !grid.isBlocked(x, y);
}

/**
 * Reconstructs the path from goal back to start by following `cameFrom`,
 * then reverses it into start->goal order.
 */
function reconstructPath(cameFrom, current) {
  const path = [current];
  let node = current;
  while (cameFrom.has(key(node.x, node.y))) {
    node = cameFrom.get(key(node.x, node.y));
    path.push(node);
  }
  path.reverse();
  return path;
}

function neighborsOf(grid, node, allowDiagonal) {
  const results = [];

  for (const { dx, dy } of ORTHOGONAL_NEIGHBORS) {
    const x = node.x + dx;
    const y = node.y + dy;
    if (isWalkable(grid, x, y)) results.push({ x, y, cost: STRAIGHT_COST });
  }

  if (!allowDiagonal) return results;

  for (const { dx, dy } of DIAGONAL_NEIGHBORS) {
    const x = node.x + dx;
    const y = node.y + dy;
    if (!isWalkable(grid, x, y)) continue;
    // Don't let the path cut across a corner formed by two blocked
    // orthogonal cells - a common A* correctness bug on grids with walls.
    const cutsCorner = !isWalkable(grid, node.x + dx, node.y) && !isWalkable(grid, node.x, node.y + dy);
    if (cutsCorner) continue;
    results.push({ x, y, cost: DIAGONAL_COST });
  }

  return results;
}

/**
 * Runs A* as a generator, yielding a snapshot after each node is expanded.
 * This is deliberately structured for step-by-step consumption (the AI
 * Visualisation Panel milestone will drive this directly to animate open
 * set / closed set / current node); `findPath` below just drains it for
 * callers that only want the final result.
 *
 * `grid` only needs `{ rows, cols, isBlocked(x, y) }` - it doesn't know or
 * care whether that's backed by a Warehouse document, an in-memory test
 * fixture, or anything else, so the same engine instance is safely reusable
 * across many robots and many warehouses with no shared state between runs.
 *
 * `options.trace` (default false, Milestone 12): when true, every yielded
 * snapshot also includes the *full* open set (not just its size) and
 * h/f/parent for every node, derived from `gScore`/`cameFrom`. This is
 * O(frontier size) per iteration instead of O(1) amortized, so it's opt-in
 * - the Robot Engine calls through this same generator on every tick via
 * `findPath` for live pathfinding, and that hot path must stay cheap. Only
 * the AI Visualisation Panel's trace endpoint (`findPathWithTrace` below)
 * ever passes `trace: true`.
 *
 * `options.emitSteps` (default true, Milestone 14): when false, the
 * generator never yields at all - the whole search runs to completion
 * inside a single `.next()` call, and `stepSnapshot` is never built. Even
 * the *cheap* (non-trace) snapshot still copies the entire closed set into
 * a fresh array every iteration (`Array.from(closedSet, ...)` below), which
 * is O(closed-set size) per node expanded - fine for one-off calls, but it
 * made every `findPath` call (the Robot Engine's hot path, called on every
 * tick for every robot that's moving or being replanned) pay O(n^2) in the
 * number of nodes explored, for step data nobody was reading: `findPath`
 * only ever looks at the generator's *final* return value. `findPath`
 * passes `emitSteps: false` so that hot path now costs what plain A*
 * actually costs; `astarSteps`/`findPathWithTrace` leave it at the
 * default so direct callers and the AI Visualisation Panel are unaffected.
 */
function* astarSteps(grid, start, goal, options = {}) {
  const {
    heuristic = 'manhattan',
    allowDiagonal = false,
    maxIterations = grid.rows * grid.cols * 8,
    trace = false,
    emitSteps = true,
  } = options;
  const h = getHeuristic(heuristic);
  const startedAt = process.hrtime.bigint();

  const result = {
    found: false,
    path: null,
    cost: null,
    nodesExplored: 0,
    executionTimeMs: 0,
    heuristic,
    allowDiagonal,
  };

  if (!isWalkable(grid, start.x, start.y) || !isWalkable(grid, goal.x, goal.y)) {
    result.executionTimeMs = msSince(startedAt);
    return result;
  }

  if (start.x === goal.x && start.y === goal.y) {
    result.found = true;
    result.path = [{ x: start.x, y: start.y }];
    result.cost = 0;
    result.executionTimeMs = msSince(startedAt);
    return result;
  }

  const openSet = new PriorityQueue((a, b) => a.f - b.f || a.h - b.h);
  const gScore = new Map([[key(start.x, start.y), 0]]);
  const cameFrom = new Map();
  const closedSet = new Set();

  openSet.push({ x: start.x, y: start.y, g: 0, h: h(start, goal), f: h(start, goal) });

  let iterations = 0;

  while (!openSet.isEmpty() && iterations < maxIterations) {
    iterations += 1;
    const current = openSet.pop();
    const currentKey = key(current.x, current.y);

    // Lazy deletion: this entry may be a stale duplicate left over from
    // before we found a cheaper route to the same cell. Skip it.
    if (closedSet.has(currentKey)) continue;
    if (current.g > gScore.get(currentKey)) continue;

    closedSet.add(currentKey);
    result.nodesExplored += 1;

    if (current.x === goal.x && current.y === goal.y) {
      const path = reconstructPath(cameFrom, { x: current.x, y: current.y });
      result.found = true;
      result.path = path;
      result.cost = current.g;
      result.executionTimeMs = msSince(startedAt);
      if (emitSteps) yield stepSnapshot({ current, openSet, closedSet, gScore, cameFrom, iterations, goal, h, trace });
      return result;
    }

    for (const neighbor of neighborsOf(grid, current, allowDiagonal)) {
      const neighborKey = key(neighbor.x, neighbor.y);
      if (closedSet.has(neighborKey)) continue;

      const tentativeG = current.g + neighbor.cost;
      const bestKnownG = gScore.get(neighborKey);

      if (bestKnownG === undefined || tentativeG < bestKnownG) {
        gScore.set(neighborKey, tentativeG);
        cameFrom.set(neighborKey, { x: current.x, y: current.y });
        const hCost = h(neighbor, goal);
        openSet.push({ x: neighbor.x, y: neighbor.y, g: tentativeG, h: hCost, f: tentativeG + hCost });
      }
    }

    if (emitSteps) yield stepSnapshot({ current, openSet, closedSet, gScore, cameFrom, iterations, goal, h, trace });
  }

  result.executionTimeMs = msSince(startedAt);
  return result;
}

/**
 * Builds one step's snapshot. `trace: false` (the default, used by every
 * existing caller - Robot Engine movement/replanning and plain `findPath`)
 * keeps the original cheap shape: current node, open-set *size* only, and
 * the closed set with just g-costs. `trace: true` additionally computes
 * the full open set (every cell in `gScore` not yet closed, with g/h/f)
 * and attaches h/f/parent to every closed node too - everything the AI
 * Visualisation Panel needs to render a frame.
 */
function stepSnapshot({ current, openSet, closedSet, gScore, cameFrom, iterations, goal, h, trace }) {
  const base = {
    step: iterations,
    current: { x: current.x, y: current.y, g: current.g, h: current.h, f: current.f },
    openSetSize: openSet.size,
    closedSet: Array.from(closedSet, (k) => {
      const [x, y] = k.split(':').map(Number);
      return { x, y, g: gScore.get(k) };
    }),
  };

  if (!trace) return base;

  const parentOf = (k) => cameFrom.get(k) || null;

  return {
    ...base,
    closedSet: base.closedSet.map((node) => {
      const hCost = h(node, goal);
      return { ...node, h: hCost, f: node.g + hCost, parent: parentOf(key(node.x, node.y)) };
    }),
    openSet: Array.from(gScore, ([k, g]) => {
      if (closedSet.has(k)) return null;
      const [x, y] = k.split(':').map(Number);
      const hCost = h({ x, y }, goal);
      return { x, y, g, h: hCost, f: g + hCost, parent: parentOf(k) };
    }).filter(Boolean),
  };
}

function msSince(startedAtBigintNs) {
  return Number(process.hrtime.bigint() - startedAtBigintNs) / 1e6;
}

/** Convenience wrapper for callers that just want the final result - passes
 * emitSteps: false so the search runs straight through without building a
 * snapshot at every node (see the doc comment on astarSteps). This is what
 * the Robot Engine calls on every tick, so it's the one place this
 * actually matters. */
function findPath(grid, start, goal, options = {}) {
  const iterator = astarSteps(grid, start, goal, { ...options, emitSteps: false });
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}

const DEFAULT_MAX_TRACE_STEPS = 400;

/**
 * Runs A* the same as `findPath`, but also collects the full step-by-step
 * trace for the AI Visualisation Panel (Milestone 12) to scrub through -
 * `{ ...result, steps, stepsTruncated }`, where `steps` is an array of the
 * enriched (`trace: true`) snapshots from `stepSnapshot` above.
 *
 * `maxTraceSteps` (default 400) caps how many of those snapshots are kept,
 * regardless of how long the search actually runs - each one is
 * O(frontier size) to build, so recording every single iteration on a
 * worst-case 80x80 maze could mean building (and shipping over HTTP, and
 * redrawing) tens of thousands of node entries. The underlying search
 * still runs to completion either way - `result.found`, `.path`, `.cost`,
 * `.nodesExplored`, and `.executionTimeMs` are unaffected by the cap, only
 * how many intermediate frames are available to step through are. When
 * the cap is hit, `stepsTruncated: true` is set so callers can say so
 * rather than silently showing a partial recording as if it were complete.
 */
function findPathWithTrace(grid, start, goal, options = {}) {
  const { maxTraceSteps = DEFAULT_MAX_TRACE_STEPS } = options;
  const iterator = astarSteps(grid, start, goal, { ...options, trace: true });
  const steps = [];
  let stepsTruncated = false;

  let step = iterator.next();
  while (!step.done) {
    if (steps.length < maxTraceSteps) {
      steps.push(step.value);
    } else {
      stepsTruncated = true;
    }
    step = iterator.next();
  }

  return { ...step.value, steps, stepsTruncated };
}

module.exports = { findPath, findPathWithTrace, astarSteps };

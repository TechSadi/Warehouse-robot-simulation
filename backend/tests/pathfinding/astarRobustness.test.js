/**
 * A* robustness: the pathological inputs, and the cost ceilings that stop
 * them turning into CPU or memory.
 *
 * The behavioural contract these pin down is that a search which cannot
 * succeed says so *cheaply*. A* here is a search over integer grid cells -
 * every node is keyed `"x:y"` and every neighbour is one whole cell away -
 * so a start or goal that is not a whole cell names a node the search can
 * never reach, and used to be answered by exploring an entire fractional
 * lattice offset from the real grid before giving up at the iteration cap.
 */
const { findPath, findPathWithTrace, astarSteps } = require('../../src/engine/pathfinding/astar');

function openGrid(rows = 20, cols = 20) {
  return { rows, cols, isBlocked: () => false };
}

/** A grid split in two by a full-height wall - nothing on one side can
 * reach anything on the other. */
function walledGrid(rows = 20, cols = 20, wallX = 10) {
  return { rows, cols, isBlocked: (x) => x === wallX };
}

/** A checkerboard of obstacles: legal, connected, and about as hostile to
 * a heuristic search as a grid gets. */
function denseGrid(rows = 40, cols = 40) {
  return { rows, cols, isBlocked: (x, y) => x % 2 === 1 && y % 2 === 1 };
}

describe('normal paths', () => {
  it('finds a shortest path on an open grid', () => {
    const result = findPath(openGrid(), { x: 0, y: 0 }, { x: 5, y: 5 });
    expect(result.found).toBe(true);
    expect(result.cost).toBe(10); // Manhattan distance, unit step cost
    expect(result.path[0]).toEqual({ x: 0, y: 0 });
    expect(result.path[result.path.length - 1]).toEqual({ x: 5, y: 5 });
  });

  it('routes around a wall through the only gap', () => {
    const grid = { rows: 6, cols: 6, isBlocked: (x, y) => x === 3 && y !== 5 };
    const result = findPath(grid, { x: 0, y: 0 }, { x: 5, y: 0 });
    expect(result.found).toBe(true);
    expect(result.path.some((p) => p.x === 3 && p.y === 5)).toBe(true);
  });

  it('treats start equals destination as a found, zero-cost path', () => {
    const result = findPath(openGrid(), { x: 3, y: 3 }, { x: 3, y: 3 });
    expect(result).toMatchObject({ found: true, cost: 0 });
    expect(result.path).toEqual([{ x: 3, y: 3 }]);
    expect(result.nodesExplored).toBe(0); // answered without searching at all
  });
});

describe('inputs that cannot succeed', () => {
  it('reports an unreachable target without exceeding the iteration ceiling', () => {
    const grid = walledGrid();
    const result = findPath(grid, { x: 0, y: 0 }, { x: 19, y: 19 });

    expect(result.found).toBe(false);
    // It explored the reachable half and stopped - not the 8x-cells cap.
    expect(result.nodesExplored).toBeLessThanOrEqual(grid.rows * wallColumns(grid));
  });

  it('refuses a start or goal that is not a whole cell, without searching', () => {
    // The bug this closes: a robot whose battery ran out part-way between
    // two cells planned from a fractional position, and A* explored a
    // lattice offset from the grid until it hit the iteration cap before
    // reporting "no path" for a plainly reachable destination.
    for (const [start, goal] of [
      [{ x: 0.5, y: 0 }, { x: 5, y: 5 }],
      [{ x: 0, y: 0 }, { x: 5.25, y: 5 }],
    ]) {
      const result = findPath(openGrid(), start, goal);
      expect(result.found).toBe(false);
      expect(result.nodesExplored).toBe(0);
    }
  });

  it('refuses non-finite coordinates', () => {
    for (const point of [{ x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: undefined, y: 1 }]) {
      expect(findPath(openGrid(), { x: 0, y: 0 }, point).found).toBe(false);
      expect(findPath(openGrid(), point, { x: 1, y: 1 }).found).toBe(false);
    }
  });

  it('refuses a missing point rather than throwing', () => {
    expect(findPath(openGrid(), { x: 0, y: 0 }, null).found).toBe(false);
    expect(findPath(openGrid(), undefined, { x: 1, y: 1 }).found).toBe(false);
  });

  it('refuses out-of-bounds and negative coordinates', () => {
    const grid = openGrid(10, 10);
    expect(findPath(grid, { x: 0, y: 0 }, { x: 10, y: 0 }).found).toBe(false);
    expect(findPath(grid, { x: 0, y: 0 }, { x: 0, y: 10 }).found).toBe(false);
    expect(findPath(grid, { x: -1, y: 0 }, { x: 1, y: 1 }).found).toBe(false);
  });

  it('accepts the boundary cells that are in bounds', () => {
    const grid = openGrid(10, 10);
    const result = findPath(grid, { x: 0, y: 0 }, { x: 9, y: 9 });
    expect(result.found).toBe(true);
  });

  it('answers a grid with unusable dimensions instead of looping on NaN', () => {
    // `rows * cols * 8` is NaN for a malformed grid, and `i < NaN` happens
    // to be false - failing safe by accident rather than by decision.
    const malformed = { rows: undefined, cols: 10, isBlocked: () => false };
    expect(findPath(malformed, { x: 0, y: 0 }, { x: 1, y: 1 }).found).toBe(false);
  });

  it('cannot start or end on a blocked cell', () => {
    const grid = { rows: 10, cols: 10, isBlocked: (x, y) => x === 5 && y === 5 };
    expect(findPath(grid, { x: 5, y: 5 }, { x: 0, y: 0 }).found).toBe(false);
    expect(findPath(grid, { x: 0, y: 0 }, { x: 5, y: 5 }).found).toBe(false);
  });
});

describe('cost ceilings', () => {
  it('bounds the search on a dense grid', () => {
    const grid = denseGrid();
    const result = findPath(grid, { x: 0, y: 0 }, { x: 38, y: 38 });

    expect(result.found).toBe(true);
    expect(result.nodesExplored).toBeLessThanOrEqual(grid.rows * grid.cols * 8);
  });

  it('bounds the search on a large grid with no path at all', () => {
    const grid = walledGrid(80, 80, 40);
    const result = findPath(grid, { x: 0, y: 0 }, { x: 79, y: 79 });

    expect(result.found).toBe(false);
    expect(result.nodesExplored).toBeLessThanOrEqual(grid.rows * grid.cols * 8);
  });

  it('honours an explicit maxIterations override', () => {
    const result = findPath(openGrid(80, 80), { x: 0, y: 0 }, { x: 79, y: 79 }, { maxIterations: 5 });
    expect(result.found).toBe(false);
    expect(result.nodesExplored).toBeLessThanOrEqual(5);
  });
});

describe('trace mode', () => {
  it('still returns the full result alongside the recorded steps', () => {
    const traced = findPathWithTrace(openGrid(), { x: 0, y: 0 }, { x: 5, y: 5 });
    const plain = findPath(openGrid(), { x: 0, y: 0 }, { x: 5, y: 5 });

    expect(traced.found).toBe(plain.found);
    expect(traced.cost).toBe(plain.cost);
    expect(traced.path).toEqual(plain.path);
    expect(traced.steps.length).toBeGreaterThan(0);
  });

  it('records the open set, closed set and parent links the visualiser needs', () => {
    const traced = findPathWithTrace(openGrid(), { x: 0, y: 0 }, { x: 4, y: 4 });
    const step = traced.steps[traced.steps.length - 1];

    expect(step).toMatchObject({
      step: expect.any(Number),
      current: expect.objectContaining({ x: expect.any(Number), g: expect.any(Number) }),
    });
    expect(Array.isArray(step.openSet)).toBe(true);
    expect(Array.isArray(step.closedSet)).toBe(true);
    expect(step.closedSet[0]).toHaveProperty('f');
    expect(step.closedSet[0]).toHaveProperty('parent');
  });

  it('stops building snapshots at the cap instead of building and discarding them', () => {
    // Each traced snapshot is O(frontier + closed set) to construct, so on
    // a dense grid the *discarded* ones used to dominate the request: tens
    // of thousands of full node lists built so that a few hundred could be
    // kept.
    const grid = denseGrid();
    const traced = findPathWithTrace(grid, { x: 0, y: 0 }, { x: 38, y: 38 }, { maxTraceSteps: 25 });

    expect(traced.steps).toHaveLength(25);
    expect(traced.stepsTruncated).toBe(true);
    expect(traced.found).toBe(true); // the search itself still ran to completion
    expect(traced.nodesExplored).toBeGreaterThan(25);
  });

  it('does not report truncation for a search that fits inside the cap', () => {
    const traced = findPathWithTrace(openGrid(), { x: 0, y: 0 }, { x: 1, y: 0 });
    expect(traced.stepsTruncated).toBe(false);
  });

  it('is measurably cheaper than recording every step of a dense search', () => {
    // Not a wall-clock benchmark - a count. `astarSteps` with the default
    // (uncapped) emit setting yields once per expansion; the capped trace
    // must build strictly fewer snapshots for the same search.
    const grid = denseGrid();
    const start = { x: 0, y: 0 };
    const goal = { x: 38, y: 38 };

    let uncappedSnapshots = 0;
    const iterator = astarSteps(grid, start, goal, { trace: true });
    for (let step = iterator.next(); !step.done; step = iterator.next()) uncappedSnapshots += 1;

    const capped = findPathWithTrace(grid, start, goal, { maxTraceSteps: 25 });

    // One snapshot per node expanded when uncapped; exactly the cap when
    // capped - the difference is work that used to be done and thrown away.
    expect(uncappedSnapshots).toBe(capped.nodesExplored);
    expect(capped.steps.length).toBe(25);
    expect(uncappedSnapshots).toBeGreaterThan(capped.steps.length);
  });
});

/** How many columns of a walled grid are reachable from x=0. */
function wallColumns(grid) {
  let x = 0;
  while (x < grid.cols && !grid.isBlocked(x, 0)) x += 1;
  return x;
}

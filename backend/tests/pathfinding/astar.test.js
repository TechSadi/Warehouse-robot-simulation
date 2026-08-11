const { findPath, findPathWithTrace, astarSteps } = require('../../src/engine/pathfinding/astar');

function makeGrid(rows, cols, blockedCells = []) {
  const blocked = new Set(blockedCells.map(([x, y]) => `${x}:${y}`));
  return {
    rows,
    cols,
    isBlocked: (x, y) => blocked.has(`${x}:${y}`),
  };
}

/** Vertical walls at every other column, each spanning the full height
 * except a single gap cell that alternates between the top and bottom
 * edge - forces a long serpentine path through nearly every cell instead
 * of a short direct one, so a search against it explores many nodes
 * rather than the handful an open grid needs. */
function combMazeBlocked(rows, cols) {
  const blocked = [];
  let gapAtTop = true;
  for (let x = 1; x < cols - 1; x += 2) {
    const gapRow = gapAtTop ? 0 : rows - 1;
    for (let y = 0; y < rows; y++) {
      if (y !== gapRow) blocked.push([x, y]);
    }
    gapAtTop = !gapAtTop;
  }
  return blocked;
}

function isAdjacent(a, b, allowDiagonal) {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  if (allowDiagonal) return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
  return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
}

/** Reference implementation: unweighted BFS shortest path (orthogonal only),
 * used to independently verify A*'s optimality rather than trusting A* to
 * grade its own homework. */
function bfsShortestLength(grid, start, goal) {
  const startKey = `${start.x}:${start.y}`;
  const goalKey = `${goal.x}:${goal.y}`;
  if (grid.isBlocked(start.x, start.y) || grid.isBlocked(goal.x, goal.y)) return null;
  if (startKey === goalKey) return 0;

  const visited = new Set([startKey]);
  let frontier = [start];
  let dist = 0;

  while (frontier.length > 0) {
    dist += 1;
    const next = [];
    for (const node of frontier) {
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const x = node.x + dx;
        const y = node.y + dy;
        if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue;
        if (grid.isBlocked(x, y)) continue;
        const k = `${x}:${y}`;
        if (visited.has(k)) continue;
        if (k === goalKey) return dist;
        visited.add(k);
        next.push({ x, y });
      }
    }
    frontier = next;
  }
  return null;
}

describe('findPath - basic correctness', () => {
  it('finds a straight-line path on an open grid with optimal cost', () => {
    const grid = makeGrid(10, 10);
    const result = findPath(grid, { x: 0, y: 0 }, { x: 5, y: 0 }, { heuristic: 'manhattan' });

    expect(result.found).toBe(true);
    expect(result.cost).toBe(5);
    expect(result.path[0]).toEqual({ x: 0, y: 0 });
    expect(result.path[result.path.length - 1]).toEqual({ x: 5, y: 0 });
  });

  it('returns a trivial single-node path when start equals goal', () => {
    const grid = makeGrid(10, 10);
    const result = findPath(grid, { x: 3, y: 3 }, { x: 3, y: 3 });
    expect(result.found).toBe(true);
    expect(result.path).toEqual([{ x: 3, y: 3 }]);
    expect(result.cost).toBe(0);
  });

  it('routes around a wall with a gap', () => {
    // A near-complete wall across row 5, leaving a single gap at x=8.
    const wall = [];
    for (let x = 0; x < 10; x++) if (x !== 8) wall.push([x, 5]);
    const grid = makeGrid(10, 10, wall);

    const result = findPath(grid, { x: 0, y: 0 }, { x: 0, y: 9 });
    expect(result.found).toBe(true);
    // Must detour through the gap at x=8.
    expect(result.path.some((p) => p.x === 8 && p.y === 5)).toBe(true);
  });

  it('returns found:false when the goal is completely enclosed', () => {
    const enclosure = [
      [4, 3], [5, 3], [6, 3],
      [4, 4], [6, 4],
      [4, 5], [5, 5], [6, 5],
    ];
    const grid = makeGrid(10, 10, enclosure);
    const result = findPath(grid, { x: 0, y: 0 }, { x: 5, y: 4 });
    expect(result.found).toBe(false);
    expect(result.path).toBeNull();
    expect(result.cost).toBeNull();
  });

  it('returns found:false when start or goal is itself blocked', () => {
    const grid = makeGrid(5, 5, [[2, 2]]);
    expect(findPath(grid, { x: 2, y: 2 }, { x: 4, y: 4 }).found).toBe(false);
    expect(findPath(grid, { x: 0, y: 0 }, { x: 2, y: 2 }).found).toBe(false);
  });

  it('returns found:false for out-of-bounds start/goal instead of throwing', () => {
    const grid = makeGrid(5, 5);
    expect(findPath(grid, { x: -1, y: 0 }, { x: 2, y: 2 }).found).toBe(false);
    expect(() => findPath(grid, { x: -1, y: 0 }, { x: 2, y: 2 })).not.toThrow();
  });
});

describe('findPath - path integrity', () => {
  it('every step is adjacent to the previous one and only visits walkable cells', () => {
    const blocked = [[3, 0], [3, 1], [3, 2], [3, 4], [3, 5], [3, 6]];
    const grid = makeGrid(8, 8, blocked);
    const result = findPath(grid, { x: 0, y: 3 }, { x: 7, y: 3 });

    expect(result.found).toBe(true);
    for (let i = 0; i < result.path.length; i++) {
      const node = result.path[i];
      expect(grid.isBlocked(node.x, node.y)).toBe(false);
      if (i > 0) expect(isAdjacent(result.path[i - 1], node, false)).toBe(true);
    }
  });
});

describe('findPath - diagonal movement', () => {
  it('takes a shorter diagonal path when allowDiagonal is true', () => {
    const grid = makeGrid(10, 10);
    const orthogonal = findPath(grid, { x: 0, y: 0 }, { x: 4, y: 4 }, { allowDiagonal: false });
    const diag = findPath(grid, { x: 0, y: 0 }, { x: 4, y: 4 }, {
      allowDiagonal: true,
      heuristic: 'diagonal',
    });

    expect(orthogonal.cost).toBe(8); // manhattan distance
    expect(diag.cost).toBeCloseTo(4 * Math.SQRT2, 10); // pure diagonal
    expect(diag.cost).toBeLessThan(orthogonal.cost);
  });

  it('does not cut across a corner formed by two blocked orthogonal cells', () => {
    // Blocking (1,0) and (0,1) means the diagonal step from (0,0) to (1,1)
    // would cut a corner between two solid walls - it must be disallowed.
    const grid = makeGrid(5, 5, [[1, 0], [0, 1]]);
    const result = findPath(grid, { x: 0, y: 0 }, { x: 1, y: 1 }, { allowDiagonal: true });

    expect(result.found).toBe(false); // (1,1) is only reachable via the forbidden corner cut
  });

  it('every diagonal path step is adjacent (including diagonals)', () => {
    const grid = makeGrid(12, 12, [[5, 5], [6, 6]]);
    const result = findPath(grid, { x: 0, y: 0 }, { x: 11, y: 11 }, {
      allowDiagonal: true,
      heuristic: 'diagonal',
    });
    expect(result.found).toBe(true);
    for (let i = 1; i < result.path.length; i++) {
      expect(isAdjacent(result.path[i - 1], result.path[i], true)).toBe(true);
    }
  });
});

describe('findPath - all heuristics agree on optimal cost (orthogonal movement)', () => {
  const scenarios = [
    { rows: 10, cols: 10, blocked: [], start: { x: 0, y: 0 }, goal: { x: 9, y: 9 } },
    {
      rows: 12,
      cols: 12,
      blocked: Array.from({ length: 10 }, (_, i) => [5, i]),
      start: { x: 0, y: 0 },
      goal: { x: 11, y: 6 },
    },
    {
      rows: 15,
      cols: 15,
      blocked: [
        ...Array.from({ length: 12 }, (_, i) => [4, i]),
        ...Array.from({ length: 12 }, (_, i) => [9, 14 - i]),
      ],
      start: { x: 0, y: 0 },
      goal: { x: 14, y: 0 },
    },
  ];

  for (const heuristic of ['manhattan', 'euclidean', 'diagonal']) {
    it(`"${heuristic}" heuristic matches BFS-optimal cost on every scenario`, () => {
      for (const s of scenarios) {
        const grid = makeGrid(s.rows, s.cols, s.blocked);
        const expected = bfsShortestLength(grid, s.start, s.goal);
        const result = findPath(grid, s.start, s.goal, { heuristic, allowDiagonal: false });

        expect(result.found).toBe(expected !== null);
        if (expected !== null) {
          expect(result.cost).toBe(expected);
        }
      }
    });
  }
});

describe('findPath - performance characteristics', () => {
  it('reports a positive node count and non-negative execution time', () => {
    const grid = makeGrid(20, 20);
    const result = findPath(grid, { x: 0, y: 0 }, { x: 19, y: 19 });
    expect(result.nodesExplored).toBeGreaterThan(0);
    expect(result.nodesExplored).toBeLessThanOrEqual(400);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('completes quickly on a larger (50x50) open grid', () => {
    const grid = makeGrid(50, 50);
    const result = findPath(grid, { x: 0, y: 0 }, { x: 49, y: 49 }, {
      allowDiagonal: true,
      heuristic: 'diagonal',
    });
    expect(result.found).toBe(true);
    expect(result.executionTimeMs).toBeLessThan(500);
  });

  it('respects maxIterations as a safety cap instead of running forever', () => {
    const grid = makeGrid(30, 30);
    const result = findPath(grid, { x: 0, y: 0 }, { x: 29, y: 29 }, { maxIterations: 3 });
    expect(result.found).toBe(false);
  });
});

describe('findPath - reusable across multiple robots', () => {
  it('produces independent, correct results for different start/goal pairs on the same grid', () => {
    const grid = makeGrid(15, 15, [[7, 0], [7, 1], [7, 2], [7, 3], [7, 4], [7, 5], [7, 6]]);

    const robotA = findPath(grid, { x: 0, y: 0 }, { x: 14, y: 0 });
    const robotB = findPath(grid, { x: 2, y: 10 }, { x: 12, y: 2 });
    const robotC = findPath(grid, { x: 0, y: 0 }, { x: 14, y: 0 }); // same as A, run again

    expect(robotA.found).toBe(true);
    expect(robotB.found).toBe(true);
    // Deterministic and stateless between calls - everything but wall-clock
    // timing should match exactly on a repeat call with the same inputs.
    expect(robotC.path).toEqual(robotA.path);
    expect(robotC.cost).toEqual(robotA.cost);
    expect(robotC.nodesExplored).toEqual(robotA.nodesExplored);
  });
});

describe('astarSteps generator', () => {
  it('yields incremental snapshots and its return value matches findPath', () => {
    const grid = makeGrid(8, 8);
    const start = { x: 0, y: 0 };
    const goal = { x: 6, y: 6 };

    const steps = [];
    const iterator = astarSteps(grid, start, goal, { allowDiagonal: true, heuristic: 'diagonal' });
    let next = iterator.next();
    while (!next.done) {
      steps.push(next.value);
      next = iterator.next();
    }

    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]).toHaveProperty('current');
    expect(steps[0]).toHaveProperty('closedSet');

    const finalResult = next.value;
    const directResult = findPath(grid, start, goal, { allowDiagonal: true, heuristic: 'diagonal' });
    expect(finalResult.found).toBe(directResult.found);
    expect(finalResult.path).toEqual(directResult.path);
    expect(finalResult.cost).toEqual(directResult.cost);
    expect(finalResult.nodesExplored).toEqual(directResult.nodesExplored);
  });

  it('without trace, step snapshots stay in the original cheap shape (no openSet array)', () => {
    const grid = makeGrid(8, 8);
    const iterator = astarSteps(grid, { x: 0, y: 0 }, { x: 6, y: 6 });
    const first = iterator.next().value;

    // current's g/h/f come for free from the popped queue entry - only the
    // *set-wide* enrichment (full open set, per-node h/f/parent) is gated
    // behind trace:true, since that's the part that costs O(frontier size).
    expect(first).not.toHaveProperty('openSet');
    expect(first.closedSet[0]).not.toHaveProperty('h');
    expect(first.closedSet[0]).not.toHaveProperty('parent');
  });

  it('emitSteps: false (Milestone 14) never yields - the whole search completes on the first next() call', () => {
    // A "comb" of alternating-gap walls forces a long serpentine path
    // rather than a short direct one, so this exercises more than a
    // handful of iterations.
    const grid = makeGrid(20, 20, combMazeBlocked(20, 20));
    const start = { x: 0, y: 0 };
    const goal = { x: 19, y: 19 };

    const iterator = astarSteps(grid, start, goal, { emitSteps: false });
    const first = iterator.next();

    expect(first.done).toBe(true); // no pause points - the loop ran to completion inline
    expect(first.value.found).toBe(true);
    const direct = findPath(grid, start, goal);
    expect(first.value.path).toEqual(direct.path);
    expect(first.value.cost).toEqual(direct.cost);
    expect(first.value.nodesExplored).toEqual(direct.nodesExplored);
  });

  it('Milestone 14: findPath (emitSteps: false) is substantially faster than yielding every step, on a search with many nodes explored', () => {
    // An open grid barely explores anything (Manhattan is a tight,
    // admissible heuristic with nothing to route around), which wouldn't
    // exercise the O(n^2) snapshot-copying cost this test is about - a
    // comb maze forces a long serpentine path that expands many nodes.
    const grid = makeGrid(60, 60, combMazeBlocked(60, 60));
    const start = { x: 0, y: 0 };
    const goal = { x: 59, y: 59 };

    function drainWithSnapshots() {
      const iterator = astarSteps(grid, start, goal, { emitSteps: true });
      let step = iterator.next();
      while (!step.done) step = iterator.next();
      return step.value;
    }

    const withSnapshotsStart = process.hrtime.bigint();
    const withSnapshotsResult = drainWithSnapshots();
    const withSnapshotsMs = Number(process.hrtime.bigint() - withSnapshotsStart) / 1e6;

    const fastStart = process.hrtime.bigint();
    const fastResult = findPath(grid, start, goal);
    const fastMs = Number(process.hrtime.bigint() - fastStart) / 1e6;

    // Same search, same answer either way - only the bookkeeping cost differs.
    expect(fastResult.found).toBe(withSnapshotsResult.found);
    expect(fastResult.path).toEqual(withSnapshotsResult.path);
    expect(fastResult.nodesExplored).toEqual(withSnapshotsResult.nodesExplored);

    // The O(n^2) snapshot-building version should be dramatically slower on
    // a search that explores thousands of nodes - a generous 2x margin
    // keeps this from flaking on a noisy CI runner while still meaningfully
    // testing that the optimization did something.
    expect(withSnapshotsResult.nodesExplored).toBeGreaterThan(1000); // sanity: this grid is big enough to matter
    expect(fastMs).toBeLessThan(withSnapshotsMs / 2);
  });
});

describe('findPathWithTrace', () => {
  it('matches findPath on found/path/cost/nodesExplored', () => {
    const grid = makeGrid(10, 10, [[3, 0], [3, 1], [3, 2], [3, 3], [3, 4]]);
    const start = { x: 0, y: 0 };
    const goal = { x: 9, y: 0 };

    const traced = findPathWithTrace(grid, start, goal);
    const direct = findPath(grid, start, goal);

    expect(traced.found).toBe(direct.found);
    expect(traced.path).toEqual(direct.path);
    expect(traced.cost).toEqual(direct.cost);
    expect(traced.nodesExplored).toEqual(direct.nodesExplored);
  });

  it('returns one step per iteration, each with an enriched open/closed set', () => {
    const grid = makeGrid(6, 6);
    const traced = findPathWithTrace(grid, { x: 0, y: 0 }, { x: 4, y: 4 });

    expect(traced.steps.length).toBe(traced.nodesExplored);
    expect(traced.stepsTruncated).toBe(false);

    const lastStep = traced.steps[traced.steps.length - 1];
    expect(Array.isArray(lastStep.openSet)).toBe(true);
    expect(lastStep.closedSet.length).toBeGreaterThan(0);
    for (const node of lastStep.closedSet) {
      expect(node).toHaveProperty('h');
      expect(node).toHaveProperty('f');
      expect(node).toHaveProperty('parent');
    }
    // The start node is its own root - no parent.
    const startEntry = lastStep.closedSet.find((n) => n.x === 0 && n.y === 0);
    expect(startEntry.parent).toBeNull();
  });

  it('open set entries reflect the best known cost, not stale duplicates', () => {
    const grid = makeGrid(5, 5);
    const traced = findPathWithTrace(grid, { x: 0, y: 0 }, { x: 4, y: 4 });
    for (const step of traced.steps) {
      const keys = step.openSet.map((n) => `${n.x}:${n.y}`);
      expect(new Set(keys).size).toBe(keys.length); // no duplicate cells in the open set
      // Nothing in the open set should also be in the closed set.
      const closedKeys = new Set(step.closedSet.map((n) => `${n.x}:${n.y}`));
      for (const k of keys) expect(closedKeys.has(k)).toBe(false);
    }
  });

  it('caps recorded steps at maxTraceSteps while the real search still runs to completion', () => {
    const grid = makeGrid(30, 30);
    const start = { x: 0, y: 0 };
    const goal = { x: 29, y: 29 };

    const full = findPathWithTrace(grid, start, goal);
    const capped = findPathWithTrace(grid, start, goal, { maxTraceSteps: 5 });

    expect(capped.steps.length).toBe(5);
    expect(capped.stepsTruncated).toBe(true);
    // The underlying search isn't cut short by the recording cap - the
    // final result is identical either way.
    expect(capped.found).toBe(full.found);
    expect(capped.path).toEqual(full.path);
    expect(capped.cost).toEqual(full.cost);
    expect(capped.nodesExplored).toEqual(full.nodesExplored);
  });

  it('does not truncate when the search finishes within the cap', () => {
    const grid = makeGrid(5, 5);
    const traced = findPathWithTrace(grid, { x: 0, y: 0 }, { x: 1, y: 0 }, { maxTraceSteps: 400 });
    expect(traced.stepsTruncated).toBe(false);
    expect(traced.steps.length).toBe(traced.nodesExplored);
  });

  it('returns an empty (but not truncated) trace when start or goal is blocked', () => {
    const grid = makeGrid(5, 5, [[1, 0]]);
    const traced = findPathWithTrace(grid, { x: 1, y: 0 }, { x: 4, y: 4 });
    expect(traced.found).toBe(false);
    expect(traced.steps).toEqual([]);
    expect(traced.stepsTruncated).toBe(false);
  });
});

const { manhattan, euclidean, diagonal, getHeuristic } = require('../../src/engine/pathfinding/heuristics');

describe('manhattan', () => {
  it('sums horizontal and vertical distance', () => {
    expect(manhattan({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(7);
  });

  it('is zero for the same point', () => {
    expect(manhattan({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(0);
  });

  it('is symmetric', () => {
    const a = { x: 1, y: 5 };
    const b = { x: 6, y: 1 };
    expect(manhattan(a, b)).toBe(manhattan(b, a));
  });
});

describe('euclidean', () => {
  it('computes straight-line distance', () => {
    expect(euclidean({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('is zero for the same point', () => {
    expect(euclidean({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(0);
  });

  it('is never greater than manhattan distance (admissibility check)', () => {
    const points = [
      [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      [{ x: 0, y: 0 }, { x: 0, y: 10 }],
      [{ x: 0, y: 0 }, { x: 7, y: 9 }],
      [{ x: 2, y: 8 }, { x: 15, y: 3 }],
    ];
    for (const [a, b] of points) {
      expect(euclidean(a, b)).toBeLessThanOrEqual(manhattan(a, b) + 1e-9);
    }
  });
});

describe('diagonal', () => {
  it('equals the straight-line diagonal distance on a pure diagonal', () => {
    expect(diagonal({ x: 0, y: 0 }, { x: 5, y: 5 })).toBeCloseTo(5 * Math.SQRT2, 10);
  });

  it('equals manhattan distance on a pure straight line', () => {
    expect(diagonal({ x: 0, y: 0 }, { x: 5, y: 0 })).toBeCloseTo(5, 10);
    expect(diagonal({ x: 0, y: 0 }, { x: 0, y: 5 })).toBeCloseTo(5, 10);
  });

  it('is exact for 8-directional movement on a mixed offset', () => {
    // 3 diagonal steps cover (3,3), then 2 more orthogonal steps cover the
    // remaining (2,0) - so the true 8-directional shortest distance is
    // 3*sqrt(2) + 2.
    const expected = 3 * Math.SQRT2 + 2;
    expect(diagonal({ x: 0, y: 0 }, { x: 5, y: 3 })).toBeCloseTo(expected, 10);
  });

  it('never overestimates euclidean distance (admissibility for 8-directional movement)', () => {
    const points = [
      [{ x: 0, y: 0 }, { x: 10, y: 3 }],
      [{ x: 1, y: 9 }, { x: 8, y: 2 }],
    ];
    for (const [a, b] of points) {
      expect(diagonal(a, b)).toBeGreaterThanOrEqual(euclidean(a, b) - 1e-9);
    }
  });
});

describe('getHeuristic', () => {
  it('resolves a heuristic function by name', () => {
    expect(getHeuristic('manhattan')).toBe(manhattan);
    expect(getHeuristic('euclidean')).toBe(euclidean);
    expect(getHeuristic('diagonal')).toBe(diagonal);
  });

  it('throws a clear error for an unknown heuristic name', () => {
    expect(() => getHeuristic('bogus')).toThrow(/Unknown heuristic/);
  });
});

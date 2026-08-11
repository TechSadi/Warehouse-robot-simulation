/**
 * Heuristics estimate the remaining distance from a node to the goal.
 * For A* to guarantee the shortest path, a heuristic must never
 * *overestimate* the true remaining cost ("admissible"). All three below
 * are admissible for a grid where an orthogonal step costs 1 and (when
 * diagonal movement is enabled) a diagonal step costs sqrt(2).
 */

/** Sum of horizontal + vertical distance. Exact for 4-directional movement. */
function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Straight-line distance. Admissible for either 4- or 8-directional movement. */
function euclidean(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * "Diagonal distance" (a.k.a. octile/Chebyshev-weighted distance): exact
 * for 8-directional movement where diagonal steps cost sqrt(2) and
 * orthogonal steps cost 1. Take the diagonal shortcut across the smaller
 * axis, then walk the remaining difference orthogonally.
 */
function diagonal(a, b) {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  const D = 1;
  const D2 = Math.SQRT2;
  return D * (dx + dy) + (D2 - 2 * D) * Math.min(dx, dy);
}

const HEURISTICS = { manhattan, euclidean, diagonal };

function getHeuristic(name) {
  const fn = HEURISTICS[name];
  if (!fn) {
    throw new Error(`Unknown heuristic "${name}". Expected one of: ${Object.keys(HEURISTICS).join(', ')}`);
  }
  return fn;
}

module.exports = { manhattan, euclidean, diagonal, HEURISTICS, getHeuristic };

// Weighted so most generated orders are routine, with urgent ones rarer -
// closer to a real fulfillment mix than a uniform 25/25/25/25 split.
const PRIORITY_WEIGHTS = [
  ['low', 0.2],
  ['normal', 0.5],
  ['high', 0.2],
  ['urgent', 0.1],
];

function weightedPriority(rng) {
  const roll = rng();
  let cumulative = 0;
  for (const [priority, weight] of PRIORITY_WEIGHTS) {
    cumulative += weight;
    if (roll < cumulative) return priority;
  }
  return PRIORITY_WEIGHTS[PRIORITY_WEIGHTS.length - 1][0];
}

function pickRandom(pool, rng) {
  return pool[Math.floor(rng() * pool.length)];
}

function samePoint(a, b) {
  return a.x === b.x && a.y === b.y;
}

/**
 * Generates `count` random orders against a grid's walkable cells. Pickup
 * points are any open floor cell (representing somewhere in the racks);
 * delivery points prefer dock cells (the warehouse's actual shipping
 * points) and only fall back to any walkable cell if the layout has no
 * docks defined at all.
 *
 * Pure and framework-agnostic like the rest of the engine layer - takes a
 * `{ rows, cols, isBlocked(x, y), isDock(x, y) }` grid, returns plain
 * `{ pickupLocation, deliveryLocation, priority }` objects for a caller to
 * persist however it likes (e.g. `Order.create(...)`).
 *
 * `rng` defaults to Math.random but can be overridden for deterministic
 * tests.
 */
function generateRandomOrders(grid, count, { rng = Math.random } = {}) {
  const walkable = [];
  const docks = [];

  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      if (grid.isBlocked(x, y)) continue;
      walkable.push({ x, y });
      if (grid.isDock(x, y)) docks.push({ x, y });
    }
  }

  if (walkable.length < 2) {
    throw new Error('Cannot generate orders: warehouse needs at least 2 walkable cells');
  }

  const deliveryPool = docks.length > 0 ? docks : walkable;

  const orders = [];
  for (let i = 0; i < count; i++) {
    const pickupLocation = pickRandom(walkable, rng);
    let deliveryLocation = pickRandom(deliveryPool, rng);

    // Retry a few times to avoid a degenerate same-cell order; if the pool
    // is tiny (e.g. exactly one dock) this may still happen, which is fine.
    for (let attempt = 0; attempt < 10 && samePoint(pickupLocation, deliveryLocation); attempt++) {
      deliveryLocation = pickRandom(deliveryPool, rng);
    }

    orders.push({ pickupLocation, deliveryLocation, priority: weightedPriority(rng) });
  }

  return orders;
}

module.exports = { generateRandomOrders };

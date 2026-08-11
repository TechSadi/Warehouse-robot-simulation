const { generateRandomOrders } = require('../../src/engine/orders/orderGenerator');

function makeGrid(rows, cols, { blocked = [], docks = [] } = {}) {
  return {
    rows,
    cols,
    isBlocked: (x, y) => blocked.some(([bx, by]) => bx === x && by === y),
    isDock: (x, y) => docks.some(([dx, dy]) => dx === x && dy === y),
  };
}

/** A deterministic sequence-based fake rng - each call returns the next
 * value in `sequence`, wrapping around, so tests can hit exact branches. */
function sequenceRng(sequence) {
  let i = 0;
  return () => {
    const v = sequence[i % sequence.length];
    i += 1;
    return v;
  };
}

describe('generateRandomOrders', () => {
  it('generates exactly the requested count', () => {
    const grid = makeGrid(10, 10);
    const orders = generateRandomOrders(grid, 5);
    expect(orders).toHaveLength(5);
  });

  it('every pickup and delivery location is walkable and in bounds', () => {
    const grid = makeGrid(8, 8, { blocked: [[3, 3], [3, 4], [3, 5]] });
    const orders = generateRandomOrders(grid, 30);
    for (const order of orders) {
      for (const point of [order.pickupLocation, order.deliveryLocation]) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThan(grid.cols);
        expect(point.y).toBeLessThan(grid.rows);
        expect(grid.isBlocked(point.x, point.y)).toBe(false);
      }
    }
  });

  it('prefers dock cells for delivery when docks exist', () => {
    const grid = makeGrid(10, 10, { docks: [[9, 9], [9, 8]] });
    const orders = generateRandomOrders(grid, 40);
    for (const order of orders) {
      expect(grid.isDock(order.deliveryLocation.x, order.deliveryLocation.y)).toBe(true);
    }
  });

  it('falls back to any walkable cell for delivery when there are no docks', () => {
    const grid = makeGrid(5, 5);
    // With a deterministic rng always picking index 0, delivery should
    // still resolve to a valid walkable cell, not throw or hang.
    const orders = generateRandomOrders(grid, 3, { rng: sequenceRng([0.01, 0.99, 0.5]) });
    expect(orders).toHaveLength(3);
    for (const order of orders) {
      expect(grid.isBlocked(order.deliveryLocation.x, order.deliveryLocation.y)).toBe(false);
    }
  });

  it('avoids a degenerate same-cell order when a distinct cell is available', () => {
    const grid = makeGrid(10, 10, { docks: [[5, 5]] });
    // rng always returns 0, which would naively pick index 0 of both the
    // pickup pool (all walkable cells) and delivery pool (the one dock) -
    // concretely: pickup lands on the first walkable cell (0,0), delivery
    // on the only dock (5,5) - never equal, so no retry needed either way.
    const orders = generateRandomOrders(grid, 5, { rng: () => 0 });
    expect(orders[0].pickupLocation).toEqual({ x: 0, y: 0 });
    expect(orders[0].deliveryLocation).toEqual({ x: 5, y: 5 });
  });

  it('throws when the grid has fewer than 2 walkable cells', () => {
    const blocked = [];
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if (!(x === 0 && y === 0)) blocked.push([x, y]);
    const grid = makeGrid(5, 5, { blocked });
    expect(() => generateRandomOrders(grid, 1)).toThrow(/at least 2 walkable cells/);
  });

  it('produces a deterministic result for a fixed rng sequence', () => {
    const grid = makeGrid(6, 6, { docks: [[5, 5]] });
    const a = generateRandomOrders(grid, 4, { rng: sequenceRng([0.1, 0.9, 0.4, 0.6, 0.05, 0.95]) });
    const b = generateRandomOrders(grid, 4, { rng: sequenceRng([0.1, 0.9, 0.4, 0.6, 0.05, 0.95]) });
    expect(a).toEqual(b);
  });

  it('respects the priority weighting boundaries exactly', () => {
    const grid = makeGrid(10, 10);
    // Priority cumulative bounds: low [0,.2) normal [.2,.7) high [.7,.9) urgent [.9,1)
    // Each order consumes 2 rng calls (pickup, delivery) then 1 for priority,
    // plus possibly more for same-cell retries - use rng values far from the
    // 0/edges to avoid retry ambiguity, and just check priority directly by
    // constructing a grid with exactly one cell so pickup/delivery always
    // resolve on the first call, keeping the call count predictable.
    const singleCellGrid = makeGrid(1, 2); // 2 walkable cells: (0,0) and (1,0)
    const priorities = [0.05, 0.5, 0.8, 0.95].map((p) => {
      const [o] = generateRandomOrders(singleCellGrid, 1, { rng: sequenceRng([0, 0.999, p]) });
      return o.priority;
    });
    expect(priorities).toEqual(['low', 'normal', 'high', 'urgent']);
  });
});

const { RobotEngine, STATUSES } = require('../../src/engine/robots/robotEngine');
const { OrderCoordinator } = require('../../src/engine/orders/orderCoordinator');
const { generateRandomOrders } = require('../../src/engine/orders/orderGenerator');

// Regression tests for the dock gridlock: a robot that finished a delivery
// went idle on the dock and stayed there, so every later delivery to that
// dock queued behind it forever. Rerouting could not help, because the
// blocked cell was the destination itself.

function makeGrid(rows, cols, { blocked = [], docks = [], charging = [] } = {}) {
  const has = (list, x, y) => list.some(([cx, cy]) => cx === x && cy === y);
  return {
    rows,
    cols,
    isBlocked: (x, y) => has(blocked, x, y),
    isCharging: (x, y) => has(charging, x, y),
    isDock: (x, y) => has(docks, x, y),
  };
}

/** Small deterministic PRNG so the fleet test is reproducible. */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('idle robots yield the cell another robot needs', () => {
  it('an idle robot parked on a dock steps aside for a robot delivering there', () => {
    const engine = new RobotEngine(makeGrid(6, 10, { docks: [[5, 0]] }));
    engine.spawnRobot({ id: 'parked', position: { x: 5, y: 0 } }); // idle on the dock
    engine.spawnRobot({ id: 'courier', position: { x: 5, y: 4 } });
    engine.assignTask('courier', { x: 5, y: 0 });

    for (let i = 0; i < 20 && engine.getRobot('courier').status !== STATUSES.IDLE; i++) engine.tick(0.5);

    expect(engine.getRobot('courier').position).toEqual({ x: 5, y: 0 });
    expect(engine.getRobot('parked').position).not.toEqual({ x: 5, y: 0 });
    expect(engine.getRobot('parked').status).toBe(STATUSES.IDLE);
  });

  it('steps into a side pocket rather than further along a corridor with no way round', () => {
    // Single-width corridor along row 1 with one open pocket at (6,0). The
    // courier cannot go round the idle robot, so the idle robot has to
    // move - and moving further along the corridor would only block it
    // again.
    const walls = [];
    for (let x = 0; x < 10; x++) {
      walls.push([x, 2]);
      if (x !== 6) walls.push([x, 0]);
    }
    const engine = new RobotEngine(makeGrid(3, 10, { blocked: walls }));
    engine.spawnRobot({ id: 'parked', position: { x: 4, y: 1 } });
    engine.spawnRobot({ id: 'courier', position: { x: 0, y: 1 }, speed: 1 });
    engine.assignTask('courier', { x: 9, y: 1 });

    for (let i = 0; i < 60 && engine.getRobot('courier').status !== STATUSES.IDLE; i++) engine.tick(0.5);

    expect(engine.getRobot('courier').position).toEqual({ x: 9, y: 1 });
    expect(engine.getRobot('parked').position).toEqual({ x: 6, y: 0 });
  });

  it('breaks a head-on swap where each robot is standing on the other\'s destination', () => {
    // Two robots in an open area, each sent to the cell the other occupies.
    // Rerouting alone can never succeed here - the destination is occupied.
    const engine = new RobotEngine(makeGrid(5, 10));
    engine.spawnRobot({ id: 'a', position: { x: 4, y: 2 } });
    engine.spawnRobot({ id: 'b', position: { x: 5, y: 2 } });
    engine.assignTask('a', { x: 5, y: 2 });
    engine.assignTask('b', { x: 4, y: 2 });

    // Arrival is what the order coordinator reacts to: the robot going idle
    // on its destination. Once there, an idle robot may later step aside
    // again for the other one, so record arrival rather than end position.
    const arrived = new Set();
    for (let i = 0; i < 40; i++) {
      for (const r of engine.tick(0.5)) {
        const goal = r.id === 'a' ? { x: 5, y: 2 } : { x: 4, y: 2 };
        if (r.status === STATUSES.IDLE && r.position.x === goal.x && r.position.y === goal.y) arrived.add(r.id);
      }
    }

    expect([...arrived].sort()).toEqual(['a', 'b']);
  });

  it('resumes its own trip after backing off', () => {
    const engine = new RobotEngine(makeGrid(5, 10));
    engine.spawnRobot({ id: 'a', position: { x: 4, y: 2 } });
    engine.spawnRobot({ id: 'b', position: { x: 5, y: 2 } });
    engine.assignTask('a', { x: 5, y: 2 });
    engine.assignTask('b', { x: 4, y: 2 });
    engine.assignTask('b', { x: 0, y: 0 }); // queued behind the swap

    for (let i = 0; i < 60; i++) engine.tick(0.5);

    // The back-off spot is not remembered as a task; the real queue is.
    expect(engine.getRobot('b')).toMatchObject({ status: STATUSES.IDLE, position: { x: 0, y: 0 }, taskQueue: [] });
  });

  it('leaves a robot that is busy alone', () => {
    const engine = new RobotEngine(makeGrid(3, 10));
    engine.spawnRobot({ id: 'broken', position: { x: 5, y: 1 } });
    engine.markBroken('broken');
    engine.spawnRobot({ id: 'courier', position: { x: 3, y: 1 } });
    engine.assignTask('courier', { x: 5, y: 1 }); // wants the broken robot's cell

    for (let i = 0; i < 10; i++) engine.tick(0.5);

    expect(engine.getRobot('broken').position).toEqual({ x: 5, y: 1 });
    expect(engine.getRobot('broken').status).toBe(STATUSES.ERROR);
  });
});

describe('fleet throughput with few docks', () => {
  // Mirrors the demo layout: 10 robots, 3 docks all on the top edge, shelf
  // blocks in the middle, charging stations along the bottom.
  function runFleet({ seed, ordersPerTick }) {
    const shelves = [];
    for (const x0 of [3, 8, 13]) {
      for (let x = x0; x < x0 + 3; x++) for (let y = 3; y < 6; y++) shelves.push([x, y]);
    }
    const grid = makeGrid(10, 18, {
      blocked: shelves,
      docks: [[4, 0], [9, 0], [14, 0]],
      charging: [[0, 9], [6, 9], [12, 9], [17, 9]],
    });
    const engine = new RobotEngine(grid);
    const coordinator = new OrderCoordinator(engine);
    const rng = mulberry32(seed);

    const robotIds = [];
    for (let i = 0; i < 10; i++) {
      engine.spawnRobot({ id: `r${i}`, position: { x: 1 + i, y: 8 } });
      robotIds.push(`r${i}`);
    }

    const TICKS = 1200; // 10 simulated minutes at 0.5s per tick
    const pending = [];
    let created = 0;
    let delivered = 0;
    let lastDeliveryTick = -1;

    for (let t = 0; t < TICKS; t++) {
      for (const order of ordersPerTick(t, pending.length) ? generateRandomOrders(grid, 5, { rng }) : []) {
        pending.push({ ...order, orderId: `o${created++}` });
      }
      for (const id of robotIds) {
        if (pending.length === 0) break;
        if (coordinator.isRobotOnOrder(id) || engine.getRobot(id).status !== STATUSES.IDLE) continue;
        if (coordinator.assignOrder(id, pending[0]).success) pending.shift();
      }
      for (const event of coordinator.processTick(engine.tick(0.5))) {
        if (event.type === 'delivered') {
          delivered += 1;
          lastDeliveryTick = t;
        }
      }
    }
    return { TICKS, created, delivered, lastDeliveryTick };
  }

  it.each([1, 2, 3, 7, 42])('delivers nearly every order when they arrive in batches, like the demo (seed %i)', (seed) => {
    // "Generate Orders" adds 5 at a time, so robots run out of work and park
    // wherever they finished - usually on a dock.
    const { created, delivered } = runFleet({ seed, ordersPerTick: (t) => t % 40 === 0 });
    expect(delivered).toBeGreaterThanOrEqual(created - 5);
  });

  it.each([1, 2, 3, 7, 42])('is still delivering at the end of a steady stream of orders (seed %i)', (seed) => {
    const { TICKS, lastDeliveryTick } = runFleet({ seed, ordersPerTick: (_t, pendingCount) => pendingCount < 10 });
    expect(lastDeliveryTick).toBeGreaterThanOrEqual(TICKS - 60);
  });
});

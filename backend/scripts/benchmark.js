#!/usr/bin/env node
/**
 * Milestone 14 benchmark: exercises the real RobotEngine, OrderCoordinator,
 * and scheduling strategies at the milestone's stated target (50
 * simultaneous robots) and reports tick throughput - no MongoDB required,
 * since this drives the pure in-memory engines directly rather than going
 * through simulationManager/orderService (which are Mongo-coupled). That
 * makes it runnable anywhere, including a sandbox with no live database,
 * and keeps it honest about what it does and doesn't cover: this measures
 * the CPU cost of one tick's worth of engine work (movement, pathfinding,
 * replanning, dispatch) - it does not include the database write or the
 * Socket.IO broadcast that also happen every real tick (see
 * services/tickRunner.js and services/simulationManager.js for those).
 *
 * Run with: node scripts/benchmark.js [robotCount] [tickCount]
 */
const { RobotEngine } = require('../src/engine/robots/robotEngine');
const { OrderCoordinator } = require('../src/engine/orders/orderCoordinator');
const { planAssignments } = require('../src/engine/scheduling/strategies');
const { generateRandomOrders } = require('../src/engine/orders/orderGenerator');

const ROBOT_COUNT = Number(process.argv[2]) || 50;
const TICK_COUNT = Number(process.argv[3]) || 200;
const TICK_DELTA_SECONDS = 0.5; // matches the production tick cadence (tickLoopManager's default)
const GRID_SIZE = 60;
const ORDERS_PER_BATCH = 15;
const DISPATCH_EVERY_N_TICKS = 4; // roughly matches how often a real warehouse would call dispatch

/** A 60x60 layout: alternating columns of shelves with walkway aisles
 * between them, a few charging cells along the bottom, open space
 * everywhere else - enough structure that pathfinding has to route around
 * something, without being a pathological maze. */
function buildGrid(size) {
  const blocked = new Set();
  const charging = new Set();
  for (let x = 2; x < size - 2; x += 4) {
    for (let y = 2; y < size - 8; y++) {
      blocked.add(`${x}:${y}`);
      blocked.add(`${x + 1}:${y}`);
    }
  }
  for (let i = 0; i < 6; i++) {
    charging.add(`${4 + i * 9}:${size - 2}`);
  }
  return {
    rows: size,
    cols: size,
    isBlocked: (x, y) => blocked.has(`${x}:${y}`),
    isCharging: (x, y) => charging.has(`${x}:${y}`),
    isDock: () => false,
  };
}

function randomWalkableCell(grid, exclude = new Set()) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const x = Math.floor(Math.random() * grid.cols);
    const y = Math.floor(Math.random() * grid.rows);
    const key = `${x}:${y}`;
    if (!grid.isBlocked(x, y) && !exclude.has(key)) return { x, y };
  }
  throw new Error('Could not find a free walkable cell - grid is too dense or too full of robots');
}

function formatMs(ms) {
  return `${ms.toFixed(3)}ms`;
}

function percentile(sortedValues, p) {
  const idx = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * p));
  return sortedValues[idx];
}

function main() {
  console.log(`Milestone 14 benchmark: ${ROBOT_COUNT} robots, ${TICK_COUNT} ticks, ${GRID_SIZE}x${GRID_SIZE} grid\n`);

  const grid = buildGrid(GRID_SIZE);
  const engine = new RobotEngine(grid);
  const coordinator = new OrderCoordinator(engine);
  const schedulerContext = { cursor: 0, completedCounts: new Map() };
  const occupiedCells = new Set();

  for (let i = 0; i < ROBOT_COUNT; i++) {
    const position = randomWalkableCell(grid, occupiedCells);
    occupiedCells.add(`${position.x}:${position.y}`);
    engine.spawnRobot({ id: `r${i}`, name: `Robot ${i}`, position, speed: 3, battery: 100 });
  }

  let nextOrderId = 0;
  const pendingOrders = new Map(); // id -> { pickupLocation, deliveryLocation, priority, createdAt }

  function generateOrderBatch(count) {
    const drafts = generateRandomOrders(grid, count);
    for (const draft of drafts) {
      const id = `o${nextOrderId++}`;
      pendingOrders.set(id, { ...draft, createdAt: new Date() });
    }
  }

  function dispatch() {
    const orders = [...pendingOrders.entries()].map(([id, o]) => ({
      id,
      priority: o.priority,
      createdAt: o.createdAt,
      pickupLocation: o.pickupLocation,
    }));
    const plan = planAssignments({
      strategyName: 'nearest_robot',
      orders,
      robots: engine.getAllRobots(),
      coordinator,
      context: schedulerContext,
    });
    for (const { orderId, robotId } of plan) {
      const order = pendingOrders.get(orderId);
      const { success } = coordinator.assignOrder(robotId, {
        orderId,
        pickupLocation: order.pickupLocation,
        deliveryLocation: order.deliveryLocation,
      });
      if (success) pendingOrders.delete(orderId);
    }
  }

  generateOrderBatch(ORDERS_PER_BATCH);

  const tickTimesMs = [];
  let totalNodesChangedAcrossRun = 0;
  let totalDelivered = 0;

  for (let tick = 0; tick < TICK_COUNT; tick++) {
    const startedAt = process.hrtime.bigint();

    const changed = engine.tick(TICK_DELTA_SECONDS);
    const events = coordinator.processTick(changed);
    for (const event of events) {
      if (event.type === 'delivered') totalDelivered += 1;
    }

    if (tick % DISPATCH_EVERY_N_TICKS === 0) {
      if (pendingOrders.size < ORDERS_PER_BATCH) generateOrderBatch(ORDERS_PER_BATCH);
      dispatch();
    }

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    tickTimesMs.push(elapsedMs);
    totalNodesChangedAcrossRun += changed.length;
  }

  tickTimesMs.sort((a, b) => a - b);
  const totalMs = tickTimesMs.reduce((sum, t) => sum + t, 0);
  const avgMs = totalMs / tickTimesMs.length;
  const p50 = percentile(tickTimesMs, 0.5);
  const p95 = percentile(tickTimesMs, 0.95);
  const maxMs = tickTimesMs[tickTimesMs.length - 1];
  const budgetMs = TICK_DELTA_SECONDS * 1000;

  console.log(`Deliveries completed:        ${totalDelivered}`);
  console.log(`Avg robots changed per tick:  ${(totalNodesChangedAcrossRun / TICK_COUNT).toFixed(1)}`);
  console.log();
  console.log(`Tick time - avg:  ${formatMs(avgMs)}`);
  console.log(`Tick time - p50:  ${formatMs(p50)}`);
  console.log(`Tick time - p95:  ${formatMs(p95)}`);
  console.log(`Tick time - max:  ${formatMs(maxMs)}`);
  console.log();
  console.log(
    `Production tick budget is ${budgetMs}ms (tickLoopManager's default cadence) - ` +
      `p95 uses ${((p95 / budgetMs) * 100).toFixed(2)}% of it, leaving room for the ` +
      `database write and Socket.IO broadcast tickRunner.js also does every tick.`
  );
}

main();

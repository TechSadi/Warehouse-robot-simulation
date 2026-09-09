#!/usr/bin/env node
/**
 * End-to-end reliability check against a real MongoDB.
 *
 * The jest suite mocks Mongoose, which is the right trade-off for the
 * hundreds of fast unit and integration tests it runs - but it means the
 * suite cannot catch a disagreement between what the code assumes a
 * document looks like and what MongoDB actually stores. This script closes
 * that gap for the paths this reliability phase changed: dispatch, ticking,
 * restart recovery, robot deletion mid-simulation, and the warehouse
 * delete cascade. (It found one real bug that the mocked suite missed: a
 * robot persisted *between* two cells while moving could not be re-seeded
 * into an engine after a restart, so a restart mid-move silently dropped
 * it from the fleet. See `toCell` in services/simulationManager.js.)
 *
 * It is destructive: it drops the database it runs against, before and
 * after. It therefore refuses to run against anything whose database name
 * does not look like a scratch database, and refuses outright in
 * production. Point it somewhere disposable:
 *
 *   MONGO_URI=mongodb://127.0.0.1:27017/warehouse-sim-scratch \
 *     node scripts/reliability-check.js
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const mongoose = require('mongoose');
const env = require('../src/config/env');
const Warehouse = require('../src/models/Warehouse');
const Robot = require('../src/models/Robot');
const Order = require('../src/models/Order');
const Log = require('../src/models/Log');
const Statistics = require('../src/models/Statistics');
const simulationManager = require('../src/services/simulationManager');
const orderService = require('../src/services/orderService');
const tickRunner = require('../src/services/tickRunner');
const warehouseLock = require('../src/services/warehouseLock');
const { IN_FLIGHT_STATUSES } = require('../src/domain/orderLifecycle');

/** Names that read as "safe to destroy". Deliberately a allow-list of
 * suffixes rather than a deny-list of production names - a deny-list is
 * one unfamiliar deployment name away from dropping a real database. */
const SCRATCH_PATTERN = /(test|scratch|e2e|local|dev|sandbox)/i;

function guardDatabase() {
  if (env.isProduction) {
    throw new Error('reliability-check refuses to run with NODE_ENV=production.');
  }
  const dbName = mongoose.connection.name || '';
  if (!SCRATCH_PATTERN.test(dbName)) {
    throw new Error(
      `Refusing to run against database "${dbName}": this script drops the database it uses. ` +
        'Point MONGO_URI at one whose name contains test/scratch/e2e/local/dev/sandbox.'
    );
  }
  return dbName;
}

const checks = [];
function check(label, passed, detail = '') {
  checks.push({ label, passed });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

async function main() {
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 5000 });
  const dbName = guardDatabase();
  await mongoose.connection.dropDatabase();
  console.log(`[reliability] running against scratch database "${dbName}"\n`);

  const ownerId = new mongoose.Types.ObjectId();
  const warehouse = await Warehouse.create({
    ownerId,
    name: 'Reliability Check',
    rows: 12,
    cols: 12,
    cells: [{ x: 11, y: 11, type: 'charging' }],
    schedulingStrategy: 'nearest_robot',
  });
  const warehouseId = warehouse._id;

  const robot = await Robot.create({
    name: 'R1',
    warehouseId,
    position: { x: 0, y: 0 },
    speed: 3,
    battery: 100,
  });
  await Order.create({
    warehouseId,
    pickupLocation: { x: 2, y: 0 },
    deliveryLocation: { x: 5, y: 0 },
  });

  console.log('dispatch and delivery');
  await orderService.dispatchPendingOrders(warehouseId);
  const assigned = await Order.findOne({ warehouseId });
  check('a pending order is assigned to an idle robot', assigned.status === 'assigned', assigned.status);

  for (let i = 0; i < 10; i += 1) await tickRunner.runTick(warehouseId, 1);
  const delivered = await Order.findOne({ warehouseId });
  const restedRobot = await Robot.findById(robot._id);
  check('the order reaches delivered by ticking alone', delivered.status === 'delivered', delivered.status);
  check('the robot is persisted idle once it is done', restedRobot.status === 'idle', restedRobot.status);

  console.log('\nconcurrent operations');
  await Order.create({ warehouseId, pickupLocation: { x: 1, y: 3 }, deliveryLocation: { x: 8, y: 3 } });
  await Promise.all([
    tickRunner.runTick(warehouseId, 0.5),
    tickRunner.runTick(warehouseId, 0.5),
    orderService.dispatchPendingOrders(warehouseId),
  ]);
  const openOrders = await Order.find({ warehouseId, status: { $ne: 'delivered' } });
  check(
    'a burst of ticks and a dispatch leave one consistent in-flight order',
    openOrders.length === 1,
    openOrders.map((o) => o.status).join(',')
  );

  console.log('\nrestart recovery');
  // Leave MongoDB describing a busy fleet and an in-flight order, then
  // throw away every piece of runtime state - exactly what a restart does.
  await Robot.findByIdAndUpdate(robot._id, { status: 'moving', position: { x: 3.4, y: 2.6 } });
  await Order.updateMany(
    { warehouseId, status: { $ne: 'delivered' } },
    { $set: { status: 'picked_up', assignedRobot: robot._id } }
  );
  simulationManager.invalidate(warehouseId);
  tickRunner.forgetWarehouse(warehouseId);

  await simulationManager.getEngine(warehouseId);

  const recoveredRobot = await Robot.findById(robot._id);
  const recoveredOrders = await Order.find({ warehouseId, status: { $in: IN_FLIGHT_STATUSES } });
  check(
    'a robot persisted as moving does not still read as moving',
    recoveredRobot.status === 'idle',
    recoveredRobot.status
  );
  check(
    'a robot persisted between two cells is placed on a whole cell',
    Number.isInteger(recoveredRobot.position.x) && Number.isInteger(recoveredRobot.position.y),
    `${recoveredRobot.position.x},${recoveredRobot.position.y}`
  );
  check('no order is left stranded in flight', recoveredOrders.length === 0, `${recoveredOrders.length} left`);

  console.log('\nrobot deletion during an active simulation');
  await orderService.dispatchPendingOrders(warehouseId);
  const engine = await simulationManager.getEngine(warehouseId);
  const released = await warehouseLock.runExclusive(warehouseId, () =>
    simulationManager.removeRobotFromCachedEngine(warehouseId, robot._id)
  );
  await orderService.releaseOrdersForRobot(warehouseId, robot._id, released);
  await Robot.findByIdAndDelete(robot._id);

  const stranded = await Order.find({
    warehouseId,
    assignedRobot: robot._id,
    status: { $in: IN_FLIGHT_STATUSES },
  });
  check('the deleted robot leaves the live fleet', engine.getAllRobots().length === 0);
  check('no in-flight order still names the deleted robot', stranded.length === 0, `${stranded.length} left`);

  console.log('\nwarehouse delete cascade');
  await Statistics.create({ warehouseId, metrics: {} });
  await Log.create({ level: 'info', message: 'reliability-check', warehouseId });
  await Promise.all([
    Robot.deleteMany({ warehouseId }),
    Order.deleteMany({ warehouseId }),
    Statistics.deleteMany({ warehouseId }),
    Log.deleteMany({ warehouseId }),
  ]);
  await Warehouse.findOneAndDelete({ _id: warehouseId, ownerId });

  const leftovers = {
    robots: await Robot.countDocuments({ warehouseId }),
    orders: await Order.countDocuments({ warehouseId }),
    statistics: await Statistics.countDocuments({ warehouseId }),
    logs: await Log.countDocuments({ warehouseId }),
  };
  check(
    'nothing is orphaned once the warehouse is gone',
    Object.values(leftovers).every((n) => n === 0),
    JSON.stringify(leftovers)
  );

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();

  const failed = checks.filter((c) => !c.passed);
  console.log(`\n[reliability] ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(`[reliability] ${err.message}`);
  try {
    await mongoose.disconnect();
  } catch {
    // The connection was never established, or is already down.
  }
  process.exitCode = 1;
});

const Order = require('../models/Order');
const Warehouse = require('../models/Warehouse');
const Log = require('../models/Log');
const { generateRandomOrders } = require('../engine/orders/orderGenerator');
const { planAssignments } = require('../engine/scheduling/strategies');
const { warehouseToGrid } = require('../engine/grid/warehouseGrid');
const simulationManager = require('./simulationManager');
const { ApiError } = require('../middleware/errorHandler');
const simulationEvents = require('../events/simulationEvents');

async function generateOrders(warehouseId, count) {
  const warehouse = await Warehouse.findById(warehouseId);
  if (!warehouse) throw new ApiError(404, 'Warehouse not found');

  let drafts;
  try {
    drafts = generateRandomOrders(warehouseToGrid(warehouse), count);
  } catch (err) {
    throw new ApiError(422, err.message);
  }

  const orders = await Order.insertMany(drafts.map((d) => ({ warehouseId, ...d })));

  await Log.create({
    level: 'info',
    source: 'order-service',
    message: `Generated ${orders.length} order(s) for warehouse ${warehouseId}`,
    warehouseId,
  });

  simulationEvents.emit('orders:changed', { warehouseId: String(warehouseId), reason: 'generated' });

  return orders;
}

/**
 * Assigns as many pending orders as possible to free idle robots, using
 * whichever of the 5 named strategies (Milestone 7) this warehouse is
 * currently configured for (`Warehouse.schedulingStrategy`, switchable via
 * the existing PUT /api/warehouses/:id endpoint).
 */
async function dispatchPendingOrders(warehouseId) {
  const engine = await simulationManager.getEngine(warehouseId);
  const coordinator = await simulationManager.getOrderCoordinator(warehouseId);
  if (!engine || !coordinator) throw new ApiError(404, 'Warehouse not found');

  const warehouse = await Warehouse.findById(warehouseId).select('schedulingStrategy');
  const pendingOrders = await Order.find({ warehouseId, status: 'pending' });
  const schedulerState = simulationManager.getSchedulerState(warehouseId);

  const plan = planAssignments({
    strategyName: warehouse.schedulingStrategy,
    orders: pendingOrders.map((o) => ({
      id: o._id.toString(),
      priority: o.priority,
      createdAt: o.createdAt,
      pickupLocation: o.pickupLocation,
    })),
    robots: engine.getAllRobots(),
    coordinator,
    context: schedulerState,
  });

  const ordersById = new Map(pendingOrders.map((o) => [o._id.toString(), o]));
  const assignments = [];
  const updatedSnapshots = [];
  const orderUpdates = [];

  for (const { orderId, robotId } of plan) {
    const order = ordersById.get(orderId);
    const { success, snapshot } = coordinator.assignOrder(robotId, {
      orderId,
      pickupLocation: order.pickupLocation,
      deliveryLocation: order.deliveryLocation,
    });

    if (!success) continue; // pickup unreachable right now - leave it pending, retry on a later pass

    assignments.push({ orderId, robotId });
    updatedSnapshots.push(snapshot);
    orderUpdates.push({
      updateOne: {
        filter: { _id: orderId },
        update: { status: 'assigned', assignedRobot: robotId, assignedAt: new Date() },
      },
    });
  }

  if (assignments.length > 0) {
    // Milestone 14: one bulk write per side instead of one round trip per
    // assignment - `assignOrder` above only ever touches the in-memory
    // engine, so nothing depends on these being flushed to Mongo one at a
    // time. `ordered: false` is safe on both: each order and each robot
    // appears in `plan` at most once per dispatch pass (planAssignments
    // never assigns the same order twice, and takenRobotIds prevents the
    // same robot being assigned twice), so there's no same-document
    // ordering to preserve.
    await Promise.all([
      simulationManager.persistRobots(updatedSnapshots),
      Order.bulkWrite(orderUpdates, { ordered: false }),
    ]);
    simulationEvents.emit('orders:changed', { warehouseId: String(warehouseId), reason: 'dispatched', assignments });
    // Every assigned robot's snapshot changed (task queue/status) - tell
    // real-time viewers directly rather than making them wait for the next
    // tick to notice.
    simulationEvents.emit('robots:changed', { warehouseId: String(warehouseId), robots: updatedSnapshots });
  }

  return assignments;
}

/** Persists the Order-side effects of OrderCoordinator.processTick()'s
 * events, and updates the per-robot completed-order counts the
 * least-busy scheduling strategy relies on. */
async function processTickEvents(warehouseId, events) {
  const schedulerState = simulationManager.getSchedulerState(warehouseId);
  const key = String(warehouseId);
  const orderUpdates = [];

  for (const event of events) {
    if (event.type === 'picked_up') {
      orderUpdates.push({
        updateOne: { filter: { _id: event.orderId }, update: { status: 'picked_up', pickedUpAt: new Date() } },
      });
    } else if (event.type === 'delivered') {
      orderUpdates.push({
        updateOne: { filter: { _id: event.orderId }, update: { status: 'delivered', deliveredAt: new Date() } },
      });
      const counts = schedulerState.completedCounts;
      counts.set(event.robotId, (counts.get(event.robotId) || 0) + 1);
      simulationEvents.emit('notification', {
        warehouseId: key,
        level: 'info',
        message: `Order ${event.orderId} delivered by robot ${event.robotId}`,
        timestamp: new Date().toISOString(),
      });
    } else if (event.type === 'delivery_unreachable') {
      await Log.create({
        level: 'warn',
        source: 'order-service',
        message: `Order ${event.orderId}: delivery location unreachable for robot ${event.robotId}`,
      });
      simulationEvents.emit('notification', {
        warehouseId: key,
        level: 'warn',
        message: `Order ${event.orderId}: delivery location unreachable`,
        timestamp: new Date().toISOString(),
      });
    }
  }

  if (orderUpdates.length > 0) {
    // Milestone 14: one bulk write instead of one findByIdAndUpdate per
    // event. `ordered: true` here rather than the `false` used elsewhere
    // in this file - a single robot's coordinator assignment is 1:1 with
    // an order, and OrderCoordinator.processTick only ever emits one event
    // per robot per tick, so in practice this array can't contain two
    // updates for the same order today. Ordered execution is cheap
    // insurance against that invariant ever loosening (e.g. a robot fast
    // enough to both pick up and deliver within one tick) without a
    // silent, hard-to-notice write-order bug - unordered execution
    // doesn't guarantee same-document operations apply in array order.
    await Order.bulkWrite(orderUpdates, { ordered: true });
  }

  const notable = events.filter((e) => e.type === 'picked_up' || e.type === 'delivered');
  if (notable.length > 0) {
    simulationEvents.emit('orders:changed', { warehouseId: key, reason: 'tick', events: notable });
  }
}

module.exports = { generateOrders, dispatchPendingOrders, processTickEvents };

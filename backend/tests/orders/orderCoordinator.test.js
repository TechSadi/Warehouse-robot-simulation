const { RobotEngine, STATUSES } = require('../../src/engine/robots/robotEngine');
const { OrderCoordinator } = require('../../src/engine/orders/orderCoordinator');

function makeGrid(rows, cols, { blocked = [] } = {}) {
  return {
    rows,
    cols,
    isBlocked: (x, y) => blocked.some(([bx, by]) => bx === x && by === y),
    isCharging: () => false,
  };
}

describe('OrderCoordinator.assignOrder', () => {
  it('starts the robot moving to the pickup location and records the assignment', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    const coordinator = new OrderCoordinator(engine);

    const { success, snapshot } = coordinator.assignOrder('r1', {
      orderId: 'o1',
      pickupLocation: { x: 5, y: 0 },
      deliveryLocation: { x: 5, y: 5 },
    });

    expect(success).toBe(true);
    expect(snapshot.status).toBe(STATUSES.MOVING);
    expect(coordinator.isRobotOnOrder('r1')).toBe(true);
    expect(coordinator.getAssignment('r1')).toMatchObject({ orderId: 'o1', phase: 'to_pickup' });
  });

  it('does not record an assignment when the pickup point is unreachable', () => {
    const wall = Array.from({ length: 10 }, (_, y) => [5, y]);
    const engine = new RobotEngine(makeGrid(10, 10, { blocked: wall }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    const coordinator = new OrderCoordinator(engine);

    const { success, snapshot } = coordinator.assignOrder('r1', {
      orderId: 'o1',
      pickupLocation: { x: 9, y: 0 },
      deliveryLocation: { x: 9, y: 9 },
    });

    expect(success).toBe(false);
    expect(snapshot.status).toBe(STATUSES.ERROR);
    expect(coordinator.isRobotOnOrder('r1')).toBe(false);
  });
});

describe('OrderCoordinator.processTick', () => {
  it('starts the delivery leg when the robot arrives at pickup, and emits a picked_up event', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 100 });
    const coordinator = new OrderCoordinator(engine);
    coordinator.assignOrder('r1', { orderId: 'o1', pickupLocation: { x: 3, y: 0 }, deliveryLocation: { x: 3, y: 7 } });

    const changed = engine.tick(1); // fast robot - reaches pickup this tick
    const events = coordinator.processTick(changed);

    expect(events).toEqual([{ type: 'picked_up', robotId: 'r1', orderId: 'o1' }]);
    expect(coordinator.getAssignment('r1').phase).toBe('to_delivery');
    expect(engine.getRobot('r1').status).toBe(STATUSES.MOVING); // already heading to delivery
  });

  it('completes the order and forgets the assignment when the robot arrives at delivery', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1000 });
    const coordinator = new OrderCoordinator(engine);
    coordinator.assignOrder('r1', { orderId: 'o1', pickupLocation: { x: 3, y: 0 }, deliveryLocation: { x: 3, y: 7 } });

    // One huge tick: reaches pickup, coordinator starts delivery leg, and
    // (since speed is huge) the same underlying engine tick already moved
    // the robot toward/through the delivery leg too. Drive ticks until the
    // coordinator reports delivery.
    let events = [];
    for (let i = 0; i < 5 && events.every((e) => e.type !== 'delivered'); i++) {
      const changed = engine.tick(1);
      events = events.concat(coordinator.processTick(changed));
    }

    const delivered = events.find((e) => e.type === 'delivered');
    expect(delivered).toEqual({ type: 'delivered', robotId: 'r1', orderId: 'o1' });
    expect(coordinator.isRobotOnOrder('r1')).toBe(false);
    expect(engine.getRobot('r1').position).toEqual({ x: 3, y: 7 });
  });

  it('emits delivery_unreachable and drops the assignment if the delivery point is enclosed', () => {
    // The delivery cell (4,1) is itself walkable, but every orthogonal
    // neighbor is blocked, so no path can ever reach it.
    const enclosure = [[3, 1], [5, 1], [4, 0], [4, 2]];
    const engine = new RobotEngine(makeGrid(10, 10, { blocked: enclosure }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 100 });
    const coordinator = new OrderCoordinator(engine);
    coordinator.assignOrder('r1', { orderId: 'o1', pickupLocation: { x: 3, y: 0 }, deliveryLocation: { x: 4, y: 1 } });

    const changed = engine.tick(1); // reaches pickup at (3,0)
    const events = coordinator.processTick(changed);

    expect(events).toEqual([{ type: 'delivery_unreachable', robotId: 'r1', orderId: 'o1' }]);
    expect(coordinator.isRobotOnOrder('r1')).toBe(false);
  });

  it('ignores robots that are not on an order', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'free', position: { x: 0, y: 0 } });
    engine.assignTask('free', { x: 2, y: 0 }); // plain movement, no order involved
    const coordinator = new OrderCoordinator(engine);

    const changed = engine.tick(5); // arrives, becomes idle
    const events = coordinator.processTick(changed);

    expect(events).toEqual([]);
  });

  it('handles multiple robots on different orders independently in one tick', () => {
    const engine = new RobotEngine(makeGrid(20, 20));
    engine.spawnRobot({ id: 'a', position: { x: 0, y: 0 }, speed: 1000 });
    engine.spawnRobot({ id: 'b', position: { x: 10, y: 10 }, speed: 1000 });
    const coordinator = new OrderCoordinator(engine);

    coordinator.assignOrder('a', { orderId: 'orderA', pickupLocation: { x: 2, y: 0 }, deliveryLocation: { x: 2, y: 2 } });
    coordinator.assignOrder('b', { orderId: 'orderB', pickupLocation: { x: 10, y: 12 }, deliveryLocation: { x: 10, y: 15 } });

    let events = [];
    for (let i = 0; i < 5; i++) {
      const changed = engine.tick(1);
      events = events.concat(coordinator.processTick(changed));
    }

    const deliveredOrders = events.filter((e) => e.type === 'delivered').map((e) => e.orderId).sort();
    expect(deliveredOrders).toEqual(['orderA', 'orderB']);
  });
});

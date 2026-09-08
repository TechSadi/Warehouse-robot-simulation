/**
 * The two domain state machines, checked from both sides.
 *
 * `domain/robotLifecycle.js` and `domain/orderLifecycle.js` are supposed to
 * be the single authority on what a robot and an order may do. The REST
 * layer was already checked against them; the simulation engine was not -
 * it assigned `robot.status` directly, so the table described the side
 * door and not the front one. These tests pin both halves to the same
 * rules, and cover the lifecycle events the engine produces.
 */
const { RobotEngine, STATUSES, MAX_TASK_QUEUE } = require('../../src/engine/robots/robotEngine');
const { OrderCoordinator } = require('../../src/engine/orders/orderCoordinator');
const robotLifecycle = require('../../src/domain/robotLifecycle');
const orderLifecycle = require('../../src/domain/orderLifecycle');

/** A plain open grid, optionally with blocked and charging cells. */
function makeGrid({ rows = 10, cols = 10, blocked = [], charging = [] } = {}) {
  const blockedSet = new Set(blocked.map((c) => `${c.x}:${c.y}`));
  const chargingSet = new Set(charging.map((c) => `${c.x}:${c.y}`));
  return {
    rows,
    cols,
    isBlocked: (x, y) => blockedSet.has(`${x}:${y}`),
    isCharging: (x, y) => chargingSet.has(`${x}:${y}`),
  };
}

function engineWith(options) {
  return new RobotEngine(makeGrid(options));
}

describe('robot state transitions', () => {
  it('only ever moves a robot along an edge the lifecycle table declares', () => {
    // Exhaustive over the transitions this engine actually performs -
    // every one of them now goes through the same assertion the REST
    // layer uses, so an illegal move fails loudly instead of quietly
    // producing a state the rest of the system does not expect.
    const engine = engineWith({ charging: [{ x: 0, y: 0 }] });
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1, battery: 50 });

    expect(engine.getRobot('r1').status).toBe(STATUSES.IDLE);

    engine.startCharging('r1'); // idle -> charging
    expect(engine.getRobot('r1').status).toBe(STATUSES.CHARGING);

    engine.markBroken('r1', 'test'); // charging -> error
    expect(engine.getRobot('r1').status).toBe(STATUSES.ERROR);

    engine.clearError('r1'); // error -> idle
    expect(engine.getRobot('r1').status).toBe(STATUSES.IDLE);

    engine.assignTask('r1', { x: 3, y: 0 }); // idle -> moving
    expect(engine.getRobot('r1').status).toBe(STATUSES.MOVING);

    engine.markBroken('r1', 'test'); // moving -> error
    expect(engine.getRobot('r1').status).toBe(STATUSES.ERROR);

    for (const [from, to] of [
      ['idle', 'charging'],
      ['charging', 'error'],
      ['error', 'idle'],
      ['idle', 'moving'],
      ['moving', 'error'],
    ]) {
      expect(robotLifecycle.canTransition(from, to)).toBe(true);
    }
  });

  it('refuses to charge a moving robot - it has to stop on a charging cell first', () => {
    const engine = engineWith({ charging: [{ x: 0, y: 0 }] });
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1 });
    engine.assignTask('r1', { x: 4, y: 0 });

    expect(() => engine.startCharging('r1')).toThrow(/moving/i);
    expect(robotLifecycle.canTransition('moving', 'charging')).toBe(false);
  });

  it('refuses to charge a robot that is not standing on a charging cell', () => {
    const engine = engineWith({ charging: [{ x: 9, y: 9 }] });
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    expect(() => engine.startCharging('r1')).toThrow(/charging cell/i);
  });

  it('parks a robot on a whole cell when its battery runs out mid-step', () => {
    // A fractional resting position is not a cell: no other robot's
    // collision check and no later A* plan can reason about it. This is
    // the bug that made clearError() on a flat robot report "no path" to a
    // destination that was plainly reachable.
    const engine = engineWith({});
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1, battery: 0.1 });
    engine.assignTask('r1', { x: 5, y: 0 });

    engine.tick(0.5); // half a cell of travel - not enough battery to finish it

    const dead = engine.getRobot('r1');
    expect(dead.status).toBe(STATUSES.ERROR);
    expect(dead.errorReason).toBe('Battery depleted');
    expect(Number.isInteger(dead.position.x)).toBe(true);
    expect(Number.isInteger(dead.position.y)).toBe(true);
  });

  it('can replan from where a flat battery left it, once it is recharged', () => {
    const engine = engineWith({});
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1, battery: 0.1 });
    engine.assignTask('r1', { x: 5, y: 0 });
    engine.tick(0.5);
    expect(engine.getRobot('r1').status).toBe(STATUSES.ERROR);

    // Simulate a recharge, then recover: the queued destination must be
    // re-plannable rather than reported unreachable.
    engine.robots.get('r1').battery = 100;
    const recovered = engine.clearError('r1');

    expect(recovered.status).toBe(STATUSES.MOVING);
    expect(recovered.errorReason).toBeNull();
  });

  it('parks a robot on a whole cell when it is marked broken mid-step', () => {
    const engine = engineWith({});
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1 });
    engine.assignTask('r1', { x: 5, y: 0 });
    engine.tick(0.5); // now half-way between (0,0) and (1,0)

    const broken = engine.markBroken('r1', 'maintenance');
    expect(Number.isInteger(broken.position.x)).toBe(true);
    expect(broken.status).toBe(STATUSES.ERROR);
  });

  it('errors, and keeps the destination retryable, when no path exists', () => {
    const engine = engineWith({ blocked: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] });
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1 });

    const snapshot = engine.assignTask('r1', { x: 5, y: 5 });

    expect(snapshot.status).toBe(STATUSES.ERROR);
    expect(snapshot.errorReason).toMatch(/No path/);
    expect(snapshot.taskQueue).toEqual([{ x: 5, y: 5 }]); // not silently dropped
  });

  it('waits rather than colliding when the next cell is occupied', () => {
    const engine = engineWith({});
    engine.spawnRobot({ id: 'blocker', position: { x: 1, y: 0 }, speed: 1 });
    engine.spawnRobot({ id: 'mover', position: { x: 0, y: 0 }, speed: 1 });
    engine.assignTask('mover', { x: 3, y: 0 });

    engine.tick(1);

    expect(engine.getRobot('mover').position).toEqual({ x: 0, y: 0 });
    expect(engine.getRobot('mover').isWaiting).toBe(true);
    expect(engine.getRobot('mover').status).toBe(STATUSES.MOVING); // still en route, just held up
  });

  it('routes around a standoff instead of waiting forever', () => {
    const engine = engineWith({});
    engine.spawnRobot({ id: 'blocker', position: { x: 1, y: 0 }, speed: 1 });
    engine.spawnRobot({ id: 'mover', position: { x: 0, y: 0 }, speed: 1 });
    engine.assignTask('mover', { x: 3, y: 0 });

    for (let i = 0; i < 5; i += 1) engine.tick(1);

    // It got past a robot that never moved - which is only possible via a
    // reroute, not by waiting.
    expect(engine.getRobot('mover').position).not.toEqual({ x: 0, y: 0 });
    expect(engine.getRobot('blocker').position).toEqual({ x: 1, y: 0 });
  });

  it('rejects a destination that is not a whole cell', () => {
    const engine = engineWith({});
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    expect(() => engine.assignTask('r1', { x: 2.5, y: 1 })).toThrow(/integer cell/i);
  });

  it('rejects spawning a robot on a fractional position', () => {
    const engine = engineWith({});
    expect(() => engine.spawnRobot({ id: 'r1', position: { x: 0.5, y: 0 } })).toThrow(/integer/i);
  });

  it('caps the task queue, so a client cannot grow one without bound', () => {
    // `POST /api/robots/:id/tasks` is a client-driven path into this
    // queue, and every entry is re-planned as the robot works through it.
    const engine = engineWith({});
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1 });

    // The first assignment is consumed immediately (the robot is idle, so
    // it starts moving), so it takes one more call than the cap to fill it.
    for (let i = 0; i <= MAX_TASK_QUEUE; i += 1) engine.assignTask('r1', { x: 5, y: 5 });
    expect(engine.getRobot('r1').taskQueue).toHaveLength(MAX_TASK_QUEUE);
    expect(() => engine.assignTask('r1', { x: 5, y: 5 })).toThrow(/queued/i);
  });

  it('clearTasks abandons the route without repairing a broken robot', () => {
    const engine = engineWith({});
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1 });
    engine.assignTask('r1', { x: 5, y: 0 });
    engine.assignTask('r1', { x: 7, y: 0 });

    const cleared = engine.clearTasks('r1');
    expect(cleared.status).toBe(STATUSES.IDLE);
    expect(cleared.taskQueue).toEqual([]);
    expect(cleared.currentTask).toBeNull();

    engine.markBroken('r1', 'broken');
    const afterBreak = engine.clearTasks('r1');
    expect(afterBreak.status).toBe(STATUSES.ERROR); // clearing work is not a repair
  });
});

describe('order state transitions', () => {
  it('allows only forward moves along the lifecycle, plus cancellation', () => {
    expect(orderLifecycle.canTransition('pending', 'assigned')).toBe(true);
    expect(orderLifecycle.canTransition('pending', 'delivered')).toBe(false);
    expect(orderLifecycle.canTransition('delivered', 'pending')).toBe(false);
    expect(orderLifecycle.canTransition('cancelled', 'pending')).toBe(false);

    for (const status of ['pending', 'assigned', 'picking_up', 'picked_up', 'delivering']) {
      expect(orderLifecycle.canTransition(status, 'cancelled')).toBe(true);
    }
    for (const status of orderLifecycle.TERMINAL_STATUSES) {
      expect(orderLifecycle.TRANSITIONS[status]).toEqual([]);
    }
  });

  it('lets an in-flight order be released back to pending', () => {
    // Reliability phase: without these edges an order whose robot broke
    // down mid-delivery had nowhere legal to go. It was not terminal, so
    // it stayed `picked_up` forever, pointing at a robot that was no
    // longer carrying it, and the dispatcher only looks at `pending`.
    for (const status of orderLifecycle.IN_FLIGHT_STATUSES) {
      expect(orderLifecycle.canTransition(status, 'pending')).toBe(true);
    }
    expect(orderLifecycle.predecessorsOf('pending')).toEqual(orderLifecycle.IN_FLIGHT_STATUSES);
  });

  it('clears the assignment and the pickup time when an order is released', () => {
    // Leaving `pickedUpAt` set would have the next robot's delivery report
    // a pickup that happened before it was even assigned.
    expect(orderLifecycle.buildTransitionUpdate('picked_up', 'pending')).toEqual({
      status: 'pending',
      assignedRobot: null,
      assignedAt: null,
      pickedUpAt: null,
    });
  });

  it('writes the transition timestamp itself rather than trusting a client', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(orderLifecycle.buildTransitionUpdate('picked_up', 'delivered', { now })).toEqual({
      status: 'delivered',
      deliveredAt: now,
    });
  });
});

describe('order coordinator lifecycle', () => {
  function setup({ blocked = [] } = {}) {
    const engine = engineWith({ blocked });
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1, battery: 100 });
    return { engine, coordinator: new OrderCoordinator(engine) };
  }

  const ORDER = { orderId: 'o1', pickupLocation: { x: 2, y: 0 }, deliveryLocation: { x: 4, y: 0 } };

  it('drives an order through pickup and delivery', () => {
    const { engine, coordinator } = setup();
    expect(coordinator.assignOrder('r1', ORDER).success).toBe(true);

    const pickupEvents = coordinator.processTick(engine.tick(2)); // arrives at pickup
    expect(pickupEvents).toEqual([{ type: 'picked_up', robotId: 'r1', orderId: 'o1' }]);

    const deliveryEvents = coordinator.processTick(engine.tick(2)); // arrives at delivery
    expect(deliveryEvents).toEqual([{ type: 'delivered', robotId: 'r1', orderId: 'o1' }]);
    expect(coordinator.isRobotOnOrder('r1')).toBe(false);
  });

  it('refuses to double-book a robot that is already on an order', () => {
    const { coordinator } = setup();
    coordinator.assignOrder('r1', ORDER);

    const second = coordinator.assignOrder('r1', { ...ORDER, orderId: 'o2' });
    expect(second).toMatchObject({ success: false, reason: 'already_assigned' });
    expect(coordinator.getAssignment('r1').orderId).toBe('o1');
  });

  it('refuses to hand an order to a robot that cannot start it', () => {
    const { engine, coordinator } = setup();
    engine.markBroken('r1', 'out of service');

    const result = coordinator.assignOrder('r1', ORDER);
    expect(result).toMatchObject({ success: false, reason: 'robot_not_idle:error' });
    expect(coordinator.isRobotOnOrder('r1')).toBe(false);
  });

  it('leaves an order untouched when its pickup point is unreachable', () => {
    const { coordinator } = setup({ blocked: [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] });

    const result = coordinator.assignOrder('r1', ORDER);
    expect(result.success).toBe(false);
    expect(coordinator.isRobotOnOrder('r1')).toBe(false);
  });

  it('releases the order when the robot carrying it fails', () => {
    // Previously the assignment simply stayed in the map and the order
    // stayed in-flight indefinitely: the only thing that could advance it
    // was an arrival from a robot no longer able to arrive anywhere.
    const { engine, coordinator } = setup();
    coordinator.assignOrder('r1', ORDER);

    const broken = engine.markBroken('r1', 'Battery depleted');
    const events = coordinator.processTick([broken]);

    expect(events).toEqual([
      { type: 'order_failed', robotId: 'r1', orderId: 'o1', reason: 'Battery depleted' },
    ]);
    expect(coordinator.isRobotOnOrder('r1')).toBe(false);
  });

  it('stops a robot chasing a cancelled order', () => {
    const { engine, coordinator } = setup();
    coordinator.assignOrder('r1', ORDER);
    expect(engine.getRobot('r1').status).toBe('moving');

    const robotId = coordinator.releaseOrder('o1');

    expect(robotId).toBe('r1');
    expect(coordinator.isRobotOnOrder('r1')).toBe(false);
    // Not merely unassigned - actually stopped, rather than driving to a
    // delivery point nobody is waiting on.
    expect(engine.getRobot('r1')).toMatchObject({ status: 'idle', currentTask: null, taskQueue: [] });
  });

  it('starts the delivery leg immediately for a robot already on the pickup cell', () => {
    const engine = engineWith({});
    engine.spawnRobot({ id: 'r1', position: { x: 2, y: 0 }, speed: 1 });
    const coordinator = new OrderCoordinator(engine);

    const result = coordinator.assignOrder('r1', ORDER);

    expect(result).toMatchObject({ success: true, pickedUpImmediately: true });
    expect(coordinator.getAssignment('r1').phase).toBe('to_delivery');
  });
});

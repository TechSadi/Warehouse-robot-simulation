const PHASES = { TO_PICKUP: 'to_pickup', TO_DELIVERY: 'to_delivery' };

/**
 * Bridges Order lifecycle onto the Robot Engine's plain-coordinate task
 * queue. The engine (Milestone 5) only knows about {x, y} destinations; it
 * has no idea an "order" exists. This class is what adds that meaning on
 * top, one RobotEngine at a time - same relationship as RobotEngine sits
 * on top of the A* engine.
 *
 * Deliberately holds only what it needs to drive the handoff itself
 * (order id + both locations), not a full Order document, so it stays
 * decoupled from Mongoose and is just as unit-testable as the engines
 * below it.
 */
class OrderCoordinator {
  constructor(engine) {
    this.engine = engine;
    /** @type {Map<string, {orderId: string, pickupLocation: object, deliveryLocation: object, phase: string}>} */
    this.assignments = new Map();
  }

  isRobotOnOrder(robotId) {
    return this.assignments.has(robotId);
  }

  getAssignment(robotId) {
    const a = this.assignments.get(robotId);
    return a ? { ...a } : null;
  }

  /**
   * Assigns an order to an idle robot's first leg (travel to pickup).
   * Returns { success, snapshot }. On failure (no path to the pickup
   * point), nothing is recorded - the caller should leave the order
   * untouched (still pending) rather than mark it assigned.
   */
  assignOrder(robotId, { orderId, pickupLocation, deliveryLocation }) {
    const snapshot = this.engine.assignTask(robotId, pickupLocation);
    if (snapshot.status === 'error') {
      return { success: false, snapshot };
    }

    if (snapshot.status === 'idle') {
      // Already standing on the pickup cell - start the delivery leg
      // immediately, since nothing would ever trigger it otherwise.
      const { deliverySnapshot, unreachable } = this._tryStartDelivery(robotId, deliveryLocation);
      if (unreachable) return { success: false, snapshot: deliverySnapshot || snapshot };
      this.assignments.set(robotId, { orderId, pickupLocation, deliveryLocation, phase: PHASES.TO_DELIVERY });
      return { success: true, snapshot: deliverySnapshot, pickedUpImmediately: true };
    }
    
    this.assignments.set(robotId, { orderId, pickupLocation, deliveryLocation, phase: PHASES.TO_PICKUP });
    return { success: true, snapshot };
  }


  _tryStartDelivery(robotId, deliveryLocation) {
    let deliverySnapshot;

    try {
      deliverySnapshot = this.engine.assignTask(robotId, deliveryLocation);
    } catch {
      return {
        deliverySnapshot: null,
        unreachable: true,
      };
    }

    return {
      deliverySnapshot,
      unreachable: deliverySnapshot.status === 'error',
    };
  }

  /**
   * Call after engine.tick() with the snapshots it returned. Detects
   * robots that just went idle while on an order - meaning they arrived
   * somewhere - and either starts the delivery leg or completes the order.
   * Returns a list of events for the caller to persist / log:
   *   { type: 'picked_up' | 'delivered' | 'delivery_unreachable', robotId, orderId }
   */
  processTick(changedSnapshots) {
    const events = [];

    for (const snapshot of changedSnapshots) {
      const assignment = this.assignments.get(snapshot.id);
      if (!assignment || snapshot.status !== 'idle') continue;

      if (assignment.phase === PHASES.TO_PICKUP) {
        let result;
        try {
          result = this.engine.assignTask(snapshot.id, assignment.deliveryLocation);
        } catch {
          result = { status: 'error' };
        }
        if (result.status === 'error') {
          this.assignments.delete(snapshot.id);
          events.push({ type: 'delivery_unreachable', robotId: snapshot.id, orderId: assignment.orderId });
        } else {
          assignment.phase = PHASES.TO_DELIVERY;
          events.push({ type: 'picked_up', robotId: snapshot.id, orderId: assignment.orderId });
        }
      } else if (assignment.phase === PHASES.TO_DELIVERY) {
        this.assignments.delete(snapshot.id);
        events.push({ type: 'delivered', robotId: snapshot.id, orderId: assignment.orderId });
      }
    }

    return events;
  }
}

module.exports = { OrderCoordinator, PHASES };

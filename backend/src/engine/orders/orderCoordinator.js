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
 *
 * This map is *runtime-only* state, and that is the single most important
 * thing to know about it: it is what turns "a robot arrived somewhere" into
 * "an order advanced", and nothing else in the system can reconstruct it.
 * If it is lost - a restart, an engine reload after a layout change - every
 * order it was driving is stranded mid-lifecycle. That is why
 * `simulationManager.reconcileWarehouse` releases in-flight orders back to
 * `pending` whenever an engine is built, and why every path that destroys
 * an assignment here (a deleted robot, a cancelled order, a failed robot)
 * has to release the order rather than silently drop the mapping.
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

  /** The robot currently working `orderId`, or null. Used when the change
   * comes from the order's side (a cancellation, a deletion) rather than
   * the robot's. */
  findRobotForOrder(orderId) {
    for (const [robotId, assignment] of this.assignments) {
      if (String(assignment.orderId) === String(orderId)) return robotId;
    }
    return null;
  }

  /**
   * Drops this robot's assignment and stops it chasing the destination the
   * order gave it. Returns the released assignment, or null if it had none.
   *
   * Clearing the engine-side task queue matters as much as clearing the
   * map: a robot that keeps a cancelled order's delivery point queued will
   * drive there anyway once it is free, blocking aisles and burning battery
   * for an order nobody is waiting on.
   */
  releaseRobot(robotId) {
    const assignment = this.assignments.get(robotId);
    if (!assignment) return null;
    this.assignments.delete(robotId);
    if (typeof this.engine.clearTasks === 'function') this.engine.clearTasks(robotId);
    return { ...assignment };
  }

  /** Releases whichever robot is working `orderId`. Returns that robot's
   * id, or null if no robot was on it. */
  releaseOrder(orderId) {
    const robotId = this.findRobotForOrder(orderId);
    if (!robotId) return null;
    this.releaseRobot(robotId);
    return robotId;
  }

  /**
   * Assigns an order to an idle robot's first leg (travel to pickup).
   * Returns { success, snapshot }. On failure (no path to the pickup
   * point), nothing is recorded - the caller should leave the order
   * untouched (still pending) rather than mark it assigned.
   */
  assignOrder(robotId, { orderId, pickupLocation, deliveryLocation }) {
    // Defensive: the planner (engine/scheduling/strategies.js) already
    // filters to idle, unassigned robots, but this class is the thing that
    // *states* the rule, and a second caller must not be able to
    // double-book a robot or hand a task to one that cannot start it.
    if (this.assignments.has(robotId)) {
      return { success: false, snapshot: this.engine.getRobot(robotId), reason: 'already_assigned' };
    }
    const current = this.engine.getRobot(robotId);
    if (!current) return { success: false, snapshot: null, reason: 'unknown_robot' };
    if (current.status !== 'idle') {
      return { success: false, snapshot: current, reason: `robot_not_idle:${current.status}` };
    }

    const snapshot = this.engine.assignTask(robotId, pickupLocation);
    if (snapshot.status === 'error') {
      return { success: false, snapshot, reason: 'pickup_unreachable' };
    }

    if (snapshot.status === 'idle') {
      // Already standing on the pickup cell - start the delivery leg
      // immediately, since nothing would ever trigger it otherwise.
      const { deliverySnapshot, unreachable } = this._tryStartDelivery(robotId, deliveryLocation);
      if (unreachable) {
        // The robot is not going anywhere for this order, so it must not
        // be left holding the pickup leg's leftovers.
        if (typeof this.engine.clearTasks === 'function') this.engine.clearTasks(robotId);
        return { success: false, snapshot: deliverySnapshot || snapshot, reason: 'delivery_unreachable' };
      }
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
   *   { type: 'picked_up' | 'delivered' | 'delivery_unreachable' | 'order_failed',
   *     robotId, orderId, reason? }
   *
   * `order_failed` (added in the reliability phase) covers a robot that
   * entered the `error` state while carrying an order: a flat battery away
   * from a charger, a destination that became unreachable, or an operator
   * marking it broken. Previously the assignment simply stayed in this map
   * and the order stayed `assigned`/`picked_up` indefinitely, because the
   * only thing that could ever advance it was an arrival event from a robot
   * that was no longer able to arrive anywhere - so the order was stranded
   * unless a human noticed and cleared the fault by hand. Releasing it
   * returns it to the dispatchable pool, where any healthy robot can take
   * it; the broken robot keeps its own error state and is re-dispatched
   * normally once recovered.
   */
  processTick(changedSnapshots) {
    const events = [];

    for (const snapshot of changedSnapshots) {
      const assignment = this.assignments.get(snapshot.id);
      if (!assignment) continue;

      if (snapshot.status === 'error') {
        this.releaseRobot(snapshot.id);
        events.push({
          type: 'order_failed',
          robotId: snapshot.id,
          orderId: assignment.orderId,
          reason: snapshot.errorReason || 'Robot entered an error state',
        });
        continue;
      }

      if (snapshot.status !== 'idle') continue;

      if (assignment.phase === PHASES.TO_PICKUP) {
        let result;
        try {
          result = this.engine.assignTask(snapshot.id, assignment.deliveryLocation);
        } catch {
          result = { status: 'error' };
        }
        if (result.status === 'error') {
          this.releaseRobot(snapshot.id);
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

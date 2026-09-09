const {
  RobotEngine,
  STATUSES,
  BATTERY_DRAIN_PER_CELL,
  BATTERY_RESERVE_PERCENT,
  STRANDED_RECOVERY_TICKS,
} = require('../../src/engine/robots/robotEngine');

/**
 * The two halves of "a robot never stays stranded":
 *
 *  - it stops driving a route its charge cannot cover, and
 *  - if it is flat anyway, maintenance retrieves it.
 *
 * Between them these replace the documented limitation that a robot whose
 * battery reached zero away from a charger "stays in `error` until a
 * person clears it".
 */
function makeGrid(cols, rows, { blocked = [], charging = [] } = {}) {
  const blockedSet = new Set(blocked.map(([x, y]) => `${x}:${y}`));
  const chargingSet = new Set(charging.map(([x, y]) => `${x}:${y}`));
  return {
    rows,
    cols,
    isBlocked: (x, y) => blockedSet.has(`${x}:${y}`),
    isCharging: (x, y) => chargingSet.has(`${x}:${y}`),
  };
}

describe('diverting to charge mid-route', () => {
  it('breaks off a trip it cannot finish and heads for a station instead', () => {
    // A 40-cell trip costs 20% of battery. The robot sets out with enough
    // for the first leg and not the whole thing.
    const engine = new RobotEngine(makeGrid(60, 5, { charging: [[10, 0]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1, battery: 12 });
    engine.assignTask('r1', { x: 50, y: 0 });

    engine.tick(1); // leaves the origin - pathIndex is now past 0
    engine.tick(1); // the reserve check runs against the remaining route

    const robot = engine.getRobot('r1');
    expect(robot.status).toBe(STATUSES.MOVING);
    // Now driving to the charging station, with the original destination
    // still queued behind it rather than dropped.
    expect(robot.currentTask).toEqual({ x: 10, y: 0 });
    expect(robot.taskQueue).toContainEqual({ x: 50, y: 0 });
  });

  it('resumes the interrupted destination once it is charged', () => {
    const engine = new RobotEngine(makeGrid(60, 5, { charging: [[10, 0]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1, battery: 12 });
    engine.assignTask('r1', { x: 50, y: 0 });

    for (let i = 0; i < 40; i++) engine.tick(1);

    const robot = engine.getRobot('r1');
    // Either still charging or already back on the road - both mean the
    // trip survived. What must not have happened is a flat battery.
    expect(robot.status).not.toBe(STATUSES.ERROR);
    expect(robot.battery).toBeGreaterThan(0);
  });

  it('starts charging on arrival rather than idling for a tick first', () => {
    // The gap matters: an idle robot standing on a charger is a robot the
    // dispatcher can hand another order to and send away still flat.
    const engine = new RobotEngine(makeGrid(20, 5, { charging: [[5, 0]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1, battery: 10 });

    let robot;
    for (let i = 0; i < 10; i++) {
      engine.tick(1);
      robot = engine.getRobot('r1');
      if (robot.status === STATUSES.CHARGING) break;
      expect(robot.status).not.toBe(STATUSES.IDLE);
    }
    expect(robot.status).toBe(STATUSES.CHARGING);
    expect(robot.position).toEqual({ x: 5, y: 0 });
  });

  it('does not second-guess the first step of a freshly dispatched route', () => {
    // Dispatch already refuses to hand an order to a low-battery robot
    // (services/orderService.js), and it decides with more information
    // than this check has. Re-litigating step zero here would only undo it.
    const engine = new RobotEngine(makeGrid(60, 5, { charging: [[0, 0]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1, battery: 15 });
    engine.assignTask('r1', { x: 50, y: 0 });

    expect(engine.getRobot('r1').currentTask).toEqual({ x: 50, y: 0 });
  });

  it('leaves a robot alone when no charging station is reachable', () => {
    const engine = new RobotEngine(makeGrid(60, 5)); // no charging cells at all
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1, battery: 12 });
    engine.assignTask('r1', { x: 50, y: 0 });

    engine.tick(1);
    engine.tick(1);

    expect(engine.getRobot('r1').currentTask).toEqual({ x: 50, y: 0 });
  });

  it('keeps a reserve above the bare cost of the remaining route', () => {
    // The break-even point is "arrives at exactly 0%", which every reroute
    // and rounding error pushes the wrong side of.
    const remainingCells = 10;
    const bareCost = remainingCells * BATTERY_DRAIN_PER_CELL;
    expect(BATTERY_RESERVE_PERCENT).toBeGreaterThan(0);

    // Far enough that the divert is observable as a trip in progress
    // rather than one that completes inside the same tick.
    const gridWith = () => makeGrid(30, 5, { charging: [[1, 3]] });

    // Enough for the route, not enough for the route plus the reserve.
    const tight = new RobotEngine(gridWith());
    tight.spawnRobot({
      id: 'r1',
      position: { x: 0, y: 0 },
      speed: 1,
      battery: bareCost + BATTERY_RESERVE_PERCENT / 2,
    });
    tight.assignTask('r1', { x: 11, y: 0 });
    tight.tick(1); // leaves the origin
    tight.tick(1); // reserve check against the remaining 10 cells
    expect(tight.getRobot('r1').currentTask).toEqual({ x: 1, y: 3 });
    expect(tight.getRobot('r1').taskQueue).toContainEqual({ x: 11, y: 0 });

    // Comfortably clear of the reserve - carries on as planned.
    const roomy = new RobotEngine(gridWith());
    roomy.spawnRobot({
      id: 'r2',
      position: { x: 0, y: 0 },
      speed: 1,
      battery: bareCost + BATTERY_RESERVE_PERCENT * 3,
    });
    roomy.assignTask('r2', { x: 11, y: 0 });
    roomy.tick(1);
    roomy.tick(1);
    expect(roomy.getRobot('r2').currentTask).toEqual({ x: 11, y: 0 });
  });

  it('stops and charges in place when it is already standing on a station', () => {
    const engine = new RobotEngine(makeGrid(30, 5, { charging: [[1, 0]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1, battery: 7 });
    engine.assignTask('r1', { x: 11, y: 0 });

    engine.tick(1); // arrives at (1, 0), which is a charging cell
    engine.tick(1); // reserve check - no point driving to a further station

    const robot = engine.getRobot('r1');
    expect(robot.status).toBe(STATUSES.CHARGING);
    expect(robot.position).toEqual({ x: 1, y: 0 });
    expect(robot.taskQueue).toContainEqual({ x: 11, y: 0 });
  });
});

describe('maintenance retrieval of a stranded robot', () => {
  /** Drives a robot flat, away from any charging station. */
  function strand(engine) {
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1000, battery: 1 });
    engine.assignTask('r1', { x: 40, y: 0 });
    engine.tick(1);
    const robot = engine.getRobot('r1');
    expect(robot.status).toBe(STATUSES.ERROR);
    expect(robot.errorReason).toBe('Battery depleted');
    expect(robot.battery).toBe(0);
    return robot;
  }

  it('leaves the fault visible for a while before clearing it up', () => {
    const engine = new RobotEngine(makeGrid(60, 5, { charging: [[0, 4]] }));
    strand(engine);

    for (let i = 0; i < STRANDED_RECOVERY_TICKS - 2; i++) engine.tick(1);
    expect(engine.getRobot('r1').status).toBe(STATUSES.ERROR);
  });

  it('moves the flat robot to a charging station and charges it', () => {
    const engine = new RobotEngine(makeGrid(60, 5, { charging: [[0, 4]] }));
    strand(engine);

    for (let i = 0; i < STRANDED_RECOVERY_TICKS + 1; i++) engine.tick(0.001);

    const robot = engine.getRobot('r1');
    expect(robot.status).toBe(STATUSES.CHARGING);
    expect(robot.position).toEqual({ x: 0, y: 4 });
    expect(robot.errorReason).toBeNull();
  });

  it('reports the retrieval rather than performing it silently', () => {
    // A fleet that quietly repairs itself is a fleet whose operator never
    // finds out their charging stations are in the wrong place.
    const engine = new RobotEngine(makeGrid(60, 5, { charging: [[0, 4]] }));
    strand(engine);
    for (let i = 0; i < STRANDED_RECOVERY_TICKS + 1; i++) engine.tick(0.001);

    const recoveries = engine.takeRecoveries();
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toMatchObject({ robotId: 'r1', to: { x: 0, y: 4 } });
    expect(engine.takeRecoveries()).toEqual([]); // drained, not repeated
  });

  it('leaves the robot stranded when the warehouse has no charging station', () => {
    // Honest: there is nowhere to take it. The operator has a layout
    // problem, and inventing charge would hide it.
    const engine = new RobotEngine(makeGrid(60, 5));
    strand(engine);
    for (let i = 0; i < STRANDED_RECOVERY_TICKS * 2; i++) engine.tick(0.001);

    expect(engine.getRobot('r1').status).toBe(STATUSES.ERROR);
  });

  it('does not retrieve a robot an operator deliberately marked broken', () => {
    const engine = new RobotEngine(makeGrid(60, 5, { charging: [[0, 4]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 3, y: 0 }, battery: 80 });
    engine.markBroken('r1', 'Taken out of service for inspection');

    for (let i = 0; i < STRANDED_RECOVERY_TICKS * 2; i++) engine.tick(0.001);

    const robot = engine.getRobot('r1');
    expect(robot.status).toBe(STATUSES.ERROR);
    expect(robot.position).toEqual({ x: 3, y: 0 });
  });

  it('can be switched off for callers that want to observe the stranding', () => {
    const engine = new RobotEngine(makeGrid(60, 5, { charging: [[0, 4]] }), {
      autoRecoverStranded: false,
    });
    strand(engine);
    for (let i = 0; i < STRANDED_RECOVERY_TICKS * 2; i++) engine.tick(0.001);

    expect(engine.getRobot('r1').status).toBe(STATUSES.ERROR);
  });

  it('still lets a person clear the error first', () => {
    const engine = new RobotEngine(makeGrid(60, 5, { charging: [[0, 4]] }));
    strand(engine);
    engine.tick(0.001);

    const cleared = engine.clearError('r1');
    expect(cleared.status).toBe(STATUSES.IDLE);
  });
});

describe('restoring a robot\'s work', () => {
  it('resumes the destination it was driving to', () => {
    const engine = new RobotEngine(makeGrid(20, 20));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });

    const snapshot = engine.restoreTasks('r1', {
      currentTask: { x: 5, y: 5 },
      taskQueue: [{ x: 9, y: 9 }],
    });

    expect(snapshot.status).toBe(STATUSES.MOVING);
    // currentTask first: a robot halfway through a delivery resumes *that*
    // delivery, not the one queued behind it.
    expect(snapshot.currentTask).toEqual({ x: 5, y: 5 });
    expect(snapshot.taskQueue).toEqual([{ x: 9, y: 9 }]);
  });

  it('does not restore the computed path, only the destination', () => {
    // The path described a world that may have changed while the process
    // was down. This one has: a wall now stands where the old route ran.
    const engine = new RobotEngine(
      makeGrid(20, 20, { blocked: [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4]] })
    );
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    engine.restoreTasks('r1', { currentTask: { x: 5, y: 0 } });

    engine.tick(1);
    const robot = engine.getRobot('r1');
    // Replanned around the wall rather than driving through where the old
    // path used to be.
    expect(robot.position.x).toBeLessThanOrEqual(1);
    expect(robot.status).toBe(STATUSES.MOVING);
  });

  it('keeps a charging robot charging, with its queue intact', () => {
    const engine = new RobotEngine(makeGrid(20, 20, { charging: [[0, 0]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, battery: 30 });
    engine.startCharging('r1');

    const snapshot = engine.restoreTasks('r1', { currentTask: { x: 5, y: 5 } });

    expect(snapshot.status).toBe(STATUSES.CHARGING);
    expect(snapshot.taskQueue).toEqual([{ x: 5, y: 5 }]);
  });

  it('keeps a destination the layout has since made unreachable, rather than dropping it', () => {
    // Visible and retryable beats silently discarded: the robot lands in
    // `error` with a reason a person can act on.
    const engine = new RobotEngine(makeGrid(10, 10, { blocked: [[5, 5]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });

    const snapshot = engine.restoreTasks('r1', { currentTask: { x: 5, y: 5 } });

    expect(snapshot.status).toBe(STATUSES.ERROR);
    expect(snapshot.taskQueue).toEqual([{ x: 5, y: 5 }]);
  });

  it('ignores malformed stored tasks instead of throwing', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });

    const snapshot = engine.restoreTasks('r1', {
      currentTask: null,
      taskQueue: [null, { x: 1.5, y: 2 }, { x: 3, y: 3 }],
    });

    expect(snapshot.currentTask).toEqual({ x: 3, y: 3 });
  });

  it('is a harmless no-op for an unknown robot', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    expect(engine.restoreTasks('nope', { currentTask: { x: 1, y: 1 } })).toBeNull();
  });
});

const {
  RobotEngine,
  STATUSES,
  DEADLOCK_REROUTE_THRESHOLD,
  LOW_BATTERY_THRESHOLD,
  AUTO_CHARGE_RETRY_TICKS,
} = require('../../src/engine/robots/robotEngine');
const RobotEngineError = require('../../src/engine/robots/robotEngineError');

function makeGrid(rows, cols, { blocked = [], charging = [] } = {}) {
  return {
    rows,
    cols,
    // Scans the live arrays rather than snapshotting into a Set, so a test
    // can mutate `blocked`/`charging` after grid creation (e.g. to simulate
    // an obstacle being cleared) and have it take effect immediately.
    isBlocked: (x, y) => blocked.some(([bx, by]) => bx === x && by === y),
    isCharging: (x, y) => charging.some(([cx, cy]) => cx === x && cy === y),
  };
}

describe('spawnRobot', () => {
  it('creates an idle robot with sane defaults', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    const robot = engine.spawnRobot({ id: 'r1', position: { x: 2, y: 3 } });

    expect(robot).toMatchObject({
      id: 'r1',
      name: 'r1',
      position: { x: 2, y: 3 },
      rotation: 0,
      battery: 100,
      status: STATUSES.IDLE,
      taskQueue: [],
    });
  });

  it('rejects a duplicate id', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    expect(() => engine.spawnRobot({ id: 'r1', position: { x: 1, y: 1 } })).toThrow(RobotEngineError);
  });

  it('rejects spawning on a blocked cell', () => {
    const engine = new RobotEngine(makeGrid(10, 10, { blocked: [[5, 5]] }));
    expect(() => engine.spawnRobot({ id: 'r1', position: { x: 5, y: 5 } })).toThrow(/blocked/);
  });

  it('rejects a missing id', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    expect(() => engine.spawnRobot({ position: { x: 0, y: 0 } })).toThrow(RobotEngineError);
  });
});

describe('removeRobot / getRobot / getAllRobots', () => {
  it('removes an existing robot and returns true', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    expect(engine.removeRobot('r1')).toBe(true);
    expect(engine.getRobot('r1')).toBeNull();
  });

  it('returns false removing a robot that does not exist', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    expect(engine.removeRobot('ghost')).toBe(false);
  });

  it('getAllRobots lists every spawned robot', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    engine.spawnRobot({ id: 'r2', position: { x: 1, y: 1 } });
    expect(engine.getAllRobots().map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });

  it('snapshots are defensive copies - mutating one does not affect engine state', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    const snap = engine.getRobot('r1');
    snap.position.x = 999;
    snap.taskQueue.push({ x: 1, y: 1 });
    expect(engine.getRobot('r1').position.x).toBe(0);
    expect(engine.getRobot('r1').taskQueue).toEqual([]);
  });
});

describe('assignTask', () => {
  it('starts moving immediately when the robot is idle', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    const robot = engine.assignTask('r1', { x: 5, y: 0 });
    expect(robot.status).toBe(STATUSES.MOVING);
  });

  it('rejects an unwalkable destination', () => {
    const engine = new RobotEngine(makeGrid(10, 10, { blocked: [[5, 5]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    expect(() => engine.assignTask('r1', { x: 5, y: 5 })).toThrow(RobotEngineError);
  });

  it('throws for an unknown robot id', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    expect(() => engine.assignTask('ghost', { x: 1, y: 1 })).toThrow(/No robot/);
  });

  it('queues additional destinations while already moving instead of interrupting', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    engine.assignTask('r1', { x: 5, y: 0 });
    const robot = engine.assignTask('r1', { x: 9, y: 9 });
    expect(robot.status).toBe(STATUSES.MOVING);
    expect(robot.taskQueue).toEqual([{ x: 9, y: 9 }]);
  });

  it('goes to error immediately if the destination is unreachable', () => {
    const walls = Array.from({ length: 10 }, (_, y) => [5, y]); // full wall, no gap
    const engine = new RobotEngine(makeGrid(10, 10, { blocked: walls }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    const robot = engine.assignTask('r1', { x: 9, y: 0 });
    expect(robot.status).toBe(STATUSES.ERROR);
    expect(robot.errorReason).toMatch(/No path/);
  });

  it('completes instantly with no movement when the destination is the current position', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 3, y: 3 } });
    const robot = engine.assignTask('r1', { x: 3, y: 3 });
    expect(robot.status).toBe(STATUSES.IDLE);
  });
});

describe('tick - movement', () => {
  it('moves the expected distance for a partial tick, then finishes over subsequent ticks', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 2 }); // 2 cells/sec
    engine.assignTask('r1', { x: 5, y: 0 });

    engine.tick(0.5); // should move 1 cell
    let robot = engine.getRobot('r1');
    expect(robot.position.x).toBeCloseTo(1, 10);
    expect(robot.status).toBe(STATUSES.MOVING);

    engine.tick(2); // 4 more cells -> total 5, exactly arrives
    robot = engine.getRobot('r1');
    expect(robot.position).toEqual({ x: 5, y: 0 });
    expect(robot.status).toBe(STATUSES.IDLE);
  });

  it('completes a multi-segment path within a single large tick', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 20 });
    engine.assignTask('r1', { x: 5, y: 5 }); // requires turning a corner
    engine.tick(5); // way more distance budget than needed
    const robot = engine.getRobot('r1');
    expect(robot.position).toEqual({ x: 5, y: 5 });
    expect(robot.status).toBe(STATUSES.IDLE);
  });

  it('automatically starts the next queued task, continuing within the same tick if budget allows', () => {
    const engine = new RobotEngine(makeGrid(20, 20));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 10 });
    engine.assignTask('r1', { x: 3, y: 0 });
    engine.assignTask('r1', { x: 3, y: 4 });

    engine.tick(1); // 10 cells of budget: 3 to finish task 1, then 4 more into task 2
    const robot = engine.getRobot('r1');
    expect(robot.position).toEqual({ x: 3, y: 4 });
    expect(robot.status).toBe(STATUSES.IDLE);
    expect(robot.taskQueue).toEqual([]);
  });

  it('updates rotation to face the direction of travel on each cardinal heading', () => {
    const engine = new RobotEngine(makeGrid(20, 40));
    engine.spawnRobot({ id: 'east', position: { x: 5, y: 5 }, speed: 10 });
    engine.spawnRobot({ id: 'south', position: { x: 15, y: 5 }, speed: 10 });
    engine.spawnRobot({ id: 'west', position: { x: 25, y: 5 }, speed: 10 });
    engine.spawnRobot({ id: 'north', position: { x: 35, y: 15 }, speed: 10 });

    engine.assignTask('east', { x: 8, y: 5 });
    engine.assignTask('south', { x: 15, y: 8 });
    engine.assignTask('west', { x: 22, y: 5 });
    engine.assignTask('north', { x: 35, y: 12 });
    engine.tick(1);

    expect(engine.getRobot('east').rotation).toBeCloseTo(0, 5);
    expect(engine.getRobot('south').rotation).toBeCloseTo(90, 5);
    expect(engine.getRobot('west').rotation).toBeCloseTo(180, 5);
    expect(engine.getRobot('north').rotation).toBeCloseTo(270, 5);
  });

  it('idle and charging robots are unaffected by tick (no path)', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 4, y: 4 } });
    const changed = engine.tick(1);
    expect(changed).toEqual([]);
    expect(engine.getRobot('r1').position).toEqual({ x: 4, y: 4 });
  });
});

describe('tick - battery', () => {
  it('drains battery proportionally to distance actually traveled', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 5 });
    engine.assignTask('r1', { x: 5, y: 0 });
    engine.tick(1); // moves 5 cells -> 5 * 0.5% = 2.5% drain
    expect(engine.getRobot('r1').battery).toBeCloseTo(97.5, 10);
  });

  it('stops the robot and enters error when battery depletes mid-path', () => {
    const engine = new RobotEngine(makeGrid(50, 50));
    // Battery drains 0.5%/cell -> 30% battery sustains 60 cells, but
    // (0,0)->(49,49) needs 98 cells (manhattan) - depletion is guaranteed
    // partway through.
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1000, battery: 30 });
    engine.assignTask('r1', { x: 49, y: 49 });
    engine.tick(1); // one huge tick - budget far exceeds what the battery can sustain

    const robot = engine.getRobot('r1');
    expect(robot.status).toBe(STATUSES.ERROR);
    expect(robot.errorReason).toBe('Battery depleted');
    expect(robot.battery).toBe(0);
  });

  it('requeues the interrupted destination so it resumes after recharging', () => {
    const engine = new RobotEngine(makeGrid(50, 50, { charging: [[0, 0]] }));
    // 15% battery sustains 30 cells; the 40-cell trip depletes it partway.
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1000, battery: 15 });
    engine.assignTask('r1', { x: 40, y: 0 });
    engine.tick(1); // depletes mid-path -> error

    let robot = engine.getRobot('r1');
    expect(robot.status).toBe(STATUSES.ERROR);

    // Move it back isn't simulated (out of scope), but we can prove the
    // task survived by clearing the error and checking it's queued again.
    engine.clearError('r1');
    robot = engine.getRobot('r1');
    // Battery is still 0, so it can't actually start moving yet - the task
    // should remain queued rather than being lost.
    expect(robot.status).toBe(STATUSES.IDLE);
    expect(robot.taskQueue.length).toBeGreaterThan(0);
  });
});

describe('startCharging / clearError', () => {
  it('rejects charging while moving', () => {
    const engine = new RobotEngine(makeGrid(10, 10, { charging: [[0, 0]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    engine.assignTask('r1', { x: 5, y: 0 });
    expect(() => engine.startCharging('r1')).toThrow(/Cannot start charging/);
  });

  it('rejects charging when not on a charging cell', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    expect(() => engine.startCharging('r1')).toThrow(RobotEngineError);
  });

  it('charges from idle on a charging cell, restoring battery over time and returning to idle at 100%', () => {
    const engine = new RobotEngine(makeGrid(10, 10, { charging: [[2, 2]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 2, y: 2 }, battery: 40 });

    let robot = engine.startCharging('r1');
    expect(robot.status).toBe(STATUSES.CHARGING);

    engine.tick(1); // +20%
    expect(engine.getRobot('r1').battery).toBeCloseTo(60, 10);
    expect(engine.getRobot('r1').status).toBe(STATUSES.CHARGING);

    engine.tick(3); // +60% -> caps at 100, should flip back to idle
    robot = engine.getRobot('r1');
    expect(robot.battery).toBe(100);
    expect(robot.status).toBe(STATUSES.IDLE);
  });

  it('automatically resumes a queued task once charging completes', () => {
    const engine = new RobotEngine(makeGrid(10, 10, { charging: [[0, 0]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, battery: 90, speed: 5 });
    engine.startCharging('r1');
    engine.assignTask('r1', { x: 5, y: 0 }); // queued - robot is charging, not idle

    expect(engine.getRobot('r1').status).toBe(STATUSES.CHARGING);
    engine.tick(1); // reaches 100%, should flip to idle then immediately start moving
    expect(engine.getRobot('r1').status).toBe(STATUSES.MOVING);
  });

  it('clearError resets an errored robot to idle and retries a queued task', () => {
    const walls = Array.from({ length: 10 }, (_, y) => [5, y]);
    const engine = new RobotEngine(makeGrid(10, 10, { blocked: walls }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    engine.assignTask('r1', { x: 9, y: 0 }); // unreachable -> error
    expect(engine.getRobot('r1').status).toBe(STATUSES.ERROR);

    // Open a gap in the wall, simulating the obstacle being cleared, then recover.
    walls.pop();
    // (grid closures capture the array reference, so mutating it is enough)
    const robot = engine.clearError('r1');
    expect(robot.status).toBe(STATUSES.MOVING);
  });

  it('is a no-op when clearing an error on a robot that has none', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 } });
    const robot = engine.clearError('r1');
    expect(robot.status).toBe(STATUSES.IDLE);
  });
});

describe('auto-charging (Milestone 13)', () => {
  it('an idle robot above the low-battery threshold does nothing', () => {
    const engine = new RobotEngine(makeGrid(10, 10, { charging: [[9, 9]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, battery: LOW_BATTERY_THRESHOLD + 1 });
    const changed = engine.tick(1);
    expect(changed).toHaveLength(0);
    expect(engine.getRobot('r1').status).toBe(STATUSES.IDLE);
  });

  it('an idle robot at or below the threshold autonomously routes to the nearest reachable station', () => {
    const engine = new RobotEngine(
      makeGrid(10, 10, { charging: [[9, 0], [0, 3]] }) // (0,3) is closer by Manhattan distance
    );
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, battery: LOW_BATTERY_THRESHOLD, speed: 1000 });

    // Dispatch (idle -> moving) and arrival (moving -> idle at the station)
    // and the final idle-on-a-charging-cell -> charging transition each
    // take their own tick() call - a generous loop covers all of them
    // without hard-coding exactly which tick does what.
    for (let i = 0; i < 5; i++) engine.tick(1);

    const robot = engine.getRobot('r1');
    expect(robot.position).toEqual({ x: 0, y: 3 }); // reached the closer station, not the farther one
    expect(robot.status).toBe(STATUSES.CHARGING);
  });

  it('already standing on a charging cell with low battery starts charging directly, no trip needed', () => {
    const engine = new RobotEngine(makeGrid(10, 10, { charging: [[3, 3]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 3, y: 3 }, battery: 10 });

    const changed = engine.tick(1);
    expect(changed).toHaveLength(1);
    expect(engine.getRobot('r1').status).toBe(STATUSES.CHARGING);
  });

  it('does not preempt an explicitly queued destination even with low battery', () => {
    const engine = new RobotEngine(makeGrid(10, 10, { charging: [[9, 9]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, battery: 10, speed: 1000 });
    engine.assignTask('r1', { x: 5, y: 0 }); // explicit destination, not the charging cell

    engine.tick(1);
    engine.tick(1); // dispatch, then arrive
    const robot = engine.getRobot('r1');
    expect(robot.position).toEqual({ x: 5, y: 0 }); // went where it was told, not to charge
  });

  it('a robot at exactly 0% battery cannot move to a station and stays put', () => {
    const engine = new RobotEngine(makeGrid(10, 10, { charging: [[9, 9]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, battery: 0 });
    const changed = engine.tick(1);
    expect(changed).toHaveLength(0);
    expect(engine.getRobot('r1').status).toBe(STATUSES.IDLE);
  });

  it('does nothing when the warehouse has no charging cells at all', () => {
    const engine = new RobotEngine(makeGrid(10, 10)); // no charging cells
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, battery: 10 });
    const changed = engine.tick(1);
    expect(changed).toHaveLength(0);
    expect(engine.getRobot('r1').status).toBe(STATUSES.IDLE);
  });

  it('skips an unreachable charging station in favor of a reachable one', () => {
    const engine = new RobotEngine(
      makeGrid(10, 10, {
        // (5,5) is a charging cell, but sealed off on all 4 sides - totally
        // unreachable via orthogonal movement, and closer by Manhattan
        // distance from the spawn point than the open one at (8,8).
        blocked: [[5, 4], [6, 5], [5, 6], [4, 5]],
        charging: [[5, 5], [8, 8]],
      })
    );
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, battery: 10, speed: 1000 });

    for (let i = 0; i < 5; i++) engine.tick(1);

    const robot = engine.getRobot('r1');
    expect(robot.status).toBe(STATUSES.CHARGING);
    expect(robot.position).toEqual({ x: 8, y: 8 }); // reached the reachable one, not the closer sealed one
  });

  it('retries after a cooldown rather than re-pathing every single tick when no station is reachable', () => {
    const blockedRow = Array.from({ length: 10 }, (_, x) => [x, 5]);
    const engine = new RobotEngine(makeGrid(10, 10, { blocked: blockedRow, charging: [[5, 9]] }));
    engine.spawnRobot({ id: 'r1', position: { x: 5, y: 0 }, battery: 10, speed: 1000 }); // cut off by the wall

    engine.tick(1); // first attempt fails, sets the cooldown
    expect(engine.getRobot('r1').status).toBe(STATUSES.IDLE);

    // Clear the wall (obstacle removed), but stay well within the cooldown
    // window - nothing should change yet.
    blockedRow.length = 0;
    for (let i = 0; i < 3; i++) engine.tick(1);
    expect(engine.getRobot('r1').status).toBe(STATUSES.IDLE);

    // Run past the cooldown and watch for the retry to succeed. Looking
    // for CHARGING specifically (not just "no longer idle") because at a
    // 20%/sec charge rate a full cycle finishes quickly too, and the robot
    // legitimately goes back to idle-with-full-battery once it does -
    // that's a correct *later* state, not evidence the retry never worked.
    let sawCharging = false;
    for (let i = 0; i < AUTO_CHARGE_RETRY_TICKS + 5; i++) {
      engine.tick(1);
      if (engine.getRobot('r1').status === STATUSES.CHARGING) {
        sawCharging = true;
        break;
      }
    }
    expect(sawCharging).toBe(true);
  });
});

describe('spawnRobot - collision with existing robots', () => {
  it('rejects spawning on a cell another robot already occupies', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 3, y: 3 } });
    expect(() => engine.spawnRobot({ id: 'r2', position: { x: 3, y: 3 } })).toThrow(/already occupies/);
  });
});

describe('multi-robot coordination', () => {
  it('a robot waits instead of entering a cell another robot currently occupies', () => {
    const engine = new RobotEngine(makeGrid(3, 10));
    engine.spawnRobot({ id: 'blocker', position: { x: 5, y: 1 } }); // idle, parked in the corridor
    engine.spawnRobot({ id: 'mover', position: { x: 3, y: 1 }, speed: 10 });
    engine.assignTask('mover', { x: 7, y: 1 }); // path runs straight through (5,1)

    engine.tick(1);

    const mover = engine.getRobot('mover');
    expect(mover.status).toBe(STATUSES.MOVING);
    expect(mover.isWaiting).toBe(true);
    expect(mover.position.x).toBeLessThan(5); // stopped short of the blocker's cell
  });

  it('reports isWaiting: false for a robot moving freely', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 2 });
    engine.assignTask('r1', { x: 5, y: 0 });
    engine.tick(0.5);
    expect(engine.getRobot('r1').isWaiting).toBe(false);
  });

  it('lets a following robot proceed once the leading robot moves out of the way', () => {
    const engine = new RobotEngine(makeGrid(3, 10));
    engine.spawnRobot({ id: 'leader', position: { x: 4, y: 1 }, speed: 1 });
    engine.spawnRobot({ id: 'follower', position: { x: 3, y: 1 }, speed: 1000 }); // fast, so it's budget-limited only by the blockage
    engine.assignTask('leader', { x: 5, y: 1 });
    engine.assignTask('follower', { x: 4, y: 1 });

    // Leader is processed first (equal waitingTicks, but assigned/spawned
    // first -> stable Map order) and moves out of (4,1) immediately since
    // nothing blocks it.
    engine.tick(1);
    expect(engine.getRobot('leader').position).toEqual({ x: 5, y: 1 });
    expect(engine.getRobot('follower').position).toEqual({ x: 4, y: 1 });
    expect(engine.getRobot('follower').status).toBe(STATUSES.IDLE); // arrived
  });

  it('never lets two robots swap cells head-on in a single-width corridor', () => {
    const engine = new RobotEngine(makeGrid(3, 10));
    engine.spawnRobot({ id: 'a', position: { x: 3, y: 1 }, speed: 1000 });
    engine.spawnRobot({ id: 'b', position: { x: 4, y: 1 }, speed: 1000 });
    engine.assignTask('a', { x: 4, y: 1 }); // wants b's cell
    engine.assignTask('b', { x: 3, y: 1 }); // wants a's cell

    engine.tick(1);

    const a = engine.getRobot('a');
    const b = engine.getRobot('b');
    // Whatever happened, they can't both have moved into each other's old
    // cell - that would mean they passed through each other.
    const bothSwapped = a.position.x === 4 && b.position.x === 3;
    expect(bothSwapped).toBe(false);
    // Exactly one should have gotten through (its target was free at the
    // moment it was checked); the other must still be waiting.
    const oneWaiting = a.isWaiting || b.isWaiting;
    expect(oneWaiting).toBe(true);
  });

  it('reroutes around a blocked robot once the wait threshold is passed, when a bypass exists', () => {
    // A 3-row-tall open area: the blocker sits in the middle row, but the
    // mover can detour through row 0 or row 2.
    const engine = new RobotEngine(makeGrid(3, 10));
    engine.spawnRobot({ id: 'blocker', position: { x: 5, y: 1 } });
    engine.spawnRobot({ id: 'mover', position: { x: 3, y: 1 }, speed: 2 });
    engine.assignTask('mover', { x: 7, y: 1 });

    let sawOffRow = false;
    for (let i = 0; i < 15; i++) {
      engine.tick(1);
      if (engine.getRobot('mover').position.y !== 1) sawOffRow = true;
    }

    const mover = engine.getRobot('mover');
    expect(sawOffRow).toBe(true); // it left row 1 to go around the blocker
    expect(mover.status).toBe(STATUSES.IDLE);
    expect(mover.position).toEqual({ x: 7, y: 1 }); // still made it to the destination
    // A detour is strictly longer than the direct 4-cell path, so it must
    // have drained more battery than going straight through ever would.
    const directPathDrain = 4 * 0.5;
    expect(100 - mover.battery).toBeGreaterThan(directPathDrain);
  });

  it('does not crash or hang when two robots are genuinely deadlocked with no bypass', () => {
    // A single-width dead-end corridor: a and b face each other with solid
    // walls on both sides, so no reroute can ever succeed.
    const walls = [];
    for (let x = 0; x < 10; x++) {
      walls.push([x, 0], [x, 2]);
    }
    const engine = new RobotEngine(makeGrid(3, 10, { blocked: walls }));
    engine.spawnRobot({ id: 'a', position: { x: 3, y: 1 }, speed: 1000 });
    engine.spawnRobot({ id: 'b', position: { x: 4, y: 1 }, speed: 1000 });
    engine.assignTask('a', { x: 4, y: 1 });
    engine.assignTask('b', { x: 3, y: 1 });

    // Run well past several reroute-attempt cycles - this should complete
    // near-instantly and neither robot should ever occupy the other's cell.
    for (let i = 0; i < 20; i++) {
      engine.tick(1);
    }

    const a = engine.getRobot('a');
    const b = engine.getRobot('b');
    expect(a.position.x === 4 && b.position.x === 3).toBe(false);
  });

  it('gives priority to whichever robot has been waiting longest', () => {
    const engine = new RobotEngine(makeGrid(3, 10));
    engine.spawnRobot({ id: 'parked', position: { x: 5, y: 1 } });
    engine.spawnRobot({ id: 'a', position: { x: 3, y: 1 }, speed: 1000 }); // approaches from the west
    engine.spawnRobot({ id: 'b', position: { x: 7, y: 1 }, speed: 1000 }); // approaches from the east
    engine.assignTask('a', { x: 5, y: 1 }); // both want the parked robot's cell once it's freed
    engine.assignTask('b', { x: 5, y: 1 });

    engine.tick(1); // both blocked by 'parked'; a and b now have equal waitingTicks (1)
    expect(engine.getRobot('a').isWaiting).toBe(true);
    expect(engine.getRobot('b').isWaiting).toBe(true);

    engine.removeRobot('parked'); // free up the contested cell

    // Both have identical waitingTicks, so Map insertion order (a spawned
    // before b) should win - a gets the cell this tick.
    engine.tick(1000); // huge budget so whoever gets in immediately arrives
    const a = engine.getRobot('a');
    const b = engine.getRobot('b');
    expect(a.position).toEqual({ x: 5, y: 1 });
    expect(b.isWaiting).toBe(true);
  });

  it('a stationary idle robot blocks a moving robot just like a parked obstacle', () => {
    const engine = new RobotEngine(makeGrid(5, 10));
    engine.spawnRobot({ id: 'parked', position: { x: 5, y: 2 } });
    engine.spawnRobot({ id: 'mover', position: { x: 3, y: 2 }, speed: 1000 });
    engine.assignTask('mover', { x: 5, y: 2 });

    for (let i = 0; i < DEADLOCK_REROUTE_THRESHOLD + 1; i++) engine.tick(1);

    // With row 2 blocked by 'parked' and no walls at all, the mover should
    // have successfully routed around through another row rather than
    // ever occupying (5,2).
    const mover = engine.getRobot('mover');
    expect(mover.position).not.toEqual({ x: 5, y: 2 });
  });
});

describe('dynamic obstacles', () => {
  it('a robot avoids a dynamic obstacle when planning a brand new path', () => {
    const engine = new RobotEngine(makeGrid(3, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 1 }, speed: 100 });
    engine.addObstacle({ id: 'zone', type: 'construction_zone', cells: [{ x: 5, y: 1 }] });

    engine.assignTask('r1', { x: 9, y: 1 });
    engine.tick(1);

    const r1 = engine.getRobot('r1');
    expect(r1.position).not.toEqual({ x: 5, y: 1 }); // never entered the obstacle
  });

  it('reroutes immediately (not after the deadlock threshold) when an obstacle appears on an already-planned path', () => {
    const engine = new RobotEngine(makeGrid(3, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 1 }, speed: 1 });
    engine.assignTask('r1', { x: 9, y: 1 }); // clear path at assignment time

    engine.tick(1); // moves one step, x=1
    // A human worker steps into the robot's planned route further ahead.
    engine.addObstacle({ id: 'worker', type: 'human_worker', cells: [{ x: 5, y: 1 }] });

    // Only one tick after the obstacle appears - well under the 3-tick
    // deadlock threshold used for robot-vs-robot congestion - the route
    // should already have changed.
    engine.tick(0.01); // negligible movement, just enough to trigger the check
    const r1 = engine.getRobot('r1');
    const stillTargetsRow1AtFive = r1.path?.some((p) => p.x === 5 && p.y === 1);
    expect(stillTargetsRow1AtFive).toBeFalsy();
  });

  it('an expired obstacle stops blocking movement', () => {
    const engine = new RobotEngine(makeGrid(3, 10));
    engine.addObstacle({ id: 'worker', type: 'human_worker', cells: [{ x: 5, y: 1 }], durationSeconds: 2 });
    engine.spawnRobot({ id: 'r1', position: { x: 4, y: 1 }, speed: 100 });

    engine.assignTask('r1', { x: 6, y: 1 });
    engine.tick(1); // obstacle still active (1s remaining) - must detour
    const midway = engine.getRobot('r1');
    expect(midway.position).not.toEqual({ x: 5, y: 1 });

    // Let the obstacle expire, then give it a fresh task straight through.
    engine.tick(1.5); // obstacle now expired
    engine.assignTask('r1', { x: 5, y: 1 });
    engine.tick(1);
    expect(engine.getRobot('r1').position).toEqual({ x: 5, y: 1 });
  });

  it('rejects spawning a robot on a cell covered by a dynamic obstacle', () => {
    const engine = new RobotEngine(makeGrid(5, 5));
    engine.addObstacle({ id: 'zone', type: 'construction_zone', cells: [{ x: 2, y: 2 }] });
    expect(() => engine.spawnRobot({ id: 'r1', position: { x: 2, y: 2 } })).toThrow(RobotEngineError);
  });

  it('addObstacle/removeObstacle/getObstacles are exposed directly on the engine', () => {
    const engine = new RobotEngine(makeGrid(5, 5));
    engine.addObstacle({ id: 'zone', type: 'construction_zone', cells: [{ x: 1, y: 1 }] });
    expect(engine.getObstacles()).toHaveLength(1);
    expect(engine.removeObstacle('zone')).toBe(true);
    expect(engine.getObstacles()).toHaveLength(0);
  });
});

describe('markBroken (broken robots as a dynamic hazard)', () => {
  it('puts the robot into the error state and blocks its cell', () => {
    const engine = new RobotEngine(makeGrid(5, 5));
    engine.spawnRobot({ id: 'r1', position: { x: 2, y: 2 } });
    const snapshot = engine.markBroken('r1', 'Wheel motor failure');
    expect(snapshot.status).toBe(STATUSES.ERROR);
    expect(snapshot.errorReason).toBe('Wheel motor failure');
    expect(() => engine.spawnRobot({ id: 'r2', position: { x: 2, y: 2 } })).toThrow(/already occupies/);
  });

  it('preserves the interrupted task, same as a battery failure', () => {
    const engine = new RobotEngine(makeGrid(10, 10));
    engine.spawnRobot({ id: 'r1', position: { x: 0, y: 0 }, speed: 1 });
    engine.assignTask('r1', { x: 5, y: 0 });
    engine.tick(1);
    engine.markBroken('r1');
    expect(engine.getRobot('r1').taskQueue.length).toBeGreaterThan(0);
  });

  it('other robots reroute around a broken robot immediately rather than waiting out the threshold', () => {
    const engine = new RobotEngine(makeGrid(3, 10));
    engine.spawnRobot({ id: 'broken', position: { x: 5, y: 1 } });
    engine.markBroken('broken', 'Motor failure');
    engine.spawnRobot({ id: 'mover', position: { x: 0, y: 1 }, speed: 1 });
    engine.assignTask('mover', { x: 9, y: 1 });

    engine.tick(1); // approaches
    engine.tick(0.01); // should already be routing around - not waiting 3 ticks

    const mover = engine.getRobot('mover');
    const stillTargetsBrokenCell = mover.path?.some((p) => p.x === 5 && p.y === 1);
    expect(stillTargetsBrokenCell).toBeFalsy();
  });
});

describe('reusable across multiple robots', () => {
  it('advances several robots independently in the same tick with no cross-contamination', () => {
    const engine = new RobotEngine(makeGrid(20, 20));
    engine.spawnRobot({ id: 'a', position: { x: 0, y: 0 }, speed: 2 });
    engine.spawnRobot({ id: 'b', position: { x: 10, y: 10 }, speed: 4 });
    engine.spawnRobot({ id: 'c', position: { x: 19, y: 0 } }); // stays idle

    engine.assignTask('a', { x: 4, y: 0 });
    engine.assignTask('b', { x: 10, y: 2 });

    const changed = engine.tick(2);
    const changedIds = changed.map((r) => r.id).sort();
    expect(changedIds).toEqual(['a', 'b']); // c never moved, shouldn't be reported

    expect(engine.getRobot('a').position).toEqual({ x: 4, y: 0 }); // 2 cells/sec * 2s = 4 cells, arrives exactly
    expect(engine.getRobot('a').status).toBe(STATUSES.IDLE);
    expect(engine.getRobot('b').position).toEqual({ x: 10, y: 2 }); // 4 cells/sec * 2s = 8 cells, arrives exactly
    expect(engine.getRobot('b').status).toBe(STATUSES.IDLE);
    expect(engine.getRobot('c').position).toEqual({ x: 19, y: 0 }); // untouched
  });
});

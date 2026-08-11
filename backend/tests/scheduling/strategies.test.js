const { planAssignments, ORDER_SELECTORS, ROBOT_SELECTORS, STRATEGY_KEYS } = require('../../src/engine/scheduling/strategies');

function order(id, { priority = 'normal', createdAt, pickupLocation = { x: 0, y: 0 } } = {}) {
  return { id, priority, createdAt, pickupLocation };
}

function robot(id, { status = 'idle', position = { x: 0, y: 0 } } = {}) {
  return { id, status, position };
}

function fakeCoordinator(busyRobotIds = []) {
  const busy = new Set(busyRobotIds);
  return { isRobotOnOrder: (id) => busy.has(id) };
}

describe('ORDER_SELECTORS', () => {
  it('fcfs sorts strictly by age, ignoring priority', () => {
    const orders = [
      order('o1', { priority: 'low', createdAt: 3 }),
      order('o2', { priority: 'urgent', createdAt: 1 }),
      order('o3', { priority: 'normal', createdAt: 2 }),
    ];
    expect(ORDER_SELECTORS.fcfs(orders).map((o) => o.id)).toEqual(['o2', 'o3', 'o1']);
  });

  it('priority sorts urgent first, then age within the same priority', () => {
    const orders = [
      order('o1', { priority: 'normal', createdAt: 1 }),
      order('o2', { priority: 'urgent', createdAt: 3 }),
      order('o3', { priority: 'low', createdAt: 2 }),
      order('o4', { priority: 'urgent', createdAt: 1 }),
    ];
    expect(ORDER_SELECTORS.priority(orders).map((o) => o.id)).toEqual(['o4', 'o2', 'o1', 'o3']);
  });
});

describe('ROBOT_SELECTORS', () => {
  it('firstAvailable picks deterministically by id, not array order', () => {
    const candidates = [robot('r3'), robot('r1'), robot('r2')];
    expect(ROBOT_SELECTORS.firstAvailable(candidates).id).toBe('r1');
  });

  it('nearest picks the geometrically closest candidate to the pickup point', () => {
    const candidates = [robot('far', { position: { x: 9, y: 9 } }), robot('near', { position: { x: 1, y: 0 } })];
    const o = order('o1', { pickupLocation: { x: 0, y: 0 } });
    expect(ROBOT_SELECTORS.nearest(candidates, o).id).toBe('near');
  });

  it('leastBusy picks the candidate with the fewest completed orders', () => {
    const candidates = [robot('busy'), robot('idle-fleet')];
    const context = { completedCounts: new Map([['busy', 5], ['idle-fleet', 1]]) };
    expect(ROBOT_SELECTORS.leastBusy(candidates, order('o1'), context).id).toBe('idle-fleet');
  });

  it('leastBusy breaks ties deterministically by id', () => {
    const candidates = [robot('r2'), robot('r1')];
    const context = { completedCounts: new Map() }; // both zero
    expect(ROBOT_SELECTORS.leastBusy(candidates, order('o1'), context).id).toBe('r1');
  });

  it('roundRobin cycles through the full roster and skips unavailable robots', () => {
    const roster = ['r1', 'r2', 'r3'];
    const context = { cursor: 0, robotOrder: roster };

    // r2 is busy this round, so starting at cursor 0 it should pick r1,
    // then next call (cursor now 1) should skip r2 and land on r3.
    const round1 = ROBOT_SELECTORS.roundRobin([robot('r1'), robot('r3')], order('o1'), context);
    expect(round1.id).toBe('r1');
    expect(context.cursor).toBe(1);

    const round2 = ROBOT_SELECTORS.roundRobin([robot('r3')], order('o2'), context);
    expect(round2.id).toBe('r3');
    expect(context.cursor).toBe(0); // wrapped back around past r3 (index 2) to 0
  });

  it('roundRobin returns null when there are no candidates', () => {
    const context = { cursor: 0, robotOrder: ['r1'] };
    expect(ROBOT_SELECTORS.roundRobin([], order('o1'), context)).toBeNull();
  });
});

describe('planAssignments', () => {
  it('exposes exactly the 5 named strategies the milestone asks for', () => {
    expect(STRATEGY_KEYS.sort()).toEqual(
      ['fcfs', 'least_busy', 'nearest_robot', 'priority_queue', 'round_robin'].sort()
    );
  });

  it('throws a clear error for an unknown strategy name', () => {
    expect(() =>
      planAssignments({ strategyName: 'bogus', orders: [], robots: [], coordinator: fakeCoordinator(), context: {} })
    ).toThrow(/Unknown scheduling strategy/);
  });

  it('fcfs: assigns oldest order first to a deterministic robot pick', () => {
    const orders = [order('o1', { createdAt: 2 }), order('o2', { createdAt: 1 })];
    const robots = [robot('r2'), robot('r1')];
    const plan = planAssignments({
      strategyName: 'fcfs',
      orders,
      robots,
      coordinator: fakeCoordinator(),
      context: {},
    });
    expect(plan).toEqual([
      { orderId: 'o2', robotId: 'r1' }, // older order first
      { orderId: 'o1', robotId: 'r2' },
    ]);
  });

  it('nearest_robot: pairs each order with its closest available robot', () => {
    const orders = [order('o1', { createdAt: 1, pickupLocation: { x: 0, y: 0 } })];
    const robots = [robot('far', { position: { x: 9, y: 9 } }), robot('near', { position: { x: 1, y: 1 } })];
    const plan = planAssignments({
      strategyName: 'nearest_robot',
      orders,
      robots,
      coordinator: fakeCoordinator(),
      context: {},
    });
    expect(plan).toEqual([{ orderId: 'o1', robotId: 'near' }]);
  });

  it('priority_queue: an urgent order jumps ahead of an older normal order', () => {
    const orders = [
      order('old-normal', { priority: 'normal', createdAt: 1, pickupLocation: { x: 0, y: 0 } }),
      order('new-urgent', { priority: 'urgent', createdAt: 5, pickupLocation: { x: 0, y: 0 } }),
    ];
    const robots = [robot('only')];
    const plan = planAssignments({
      strategyName: 'priority_queue',
      orders,
      robots,
      coordinator: fakeCoordinator(),
      context: {},
    });
    // Only one robot exists, so only the first-selected order gets assigned.
    expect(plan).toEqual([{ orderId: 'new-urgent', robotId: 'only' }]);
  });

  it('least_busy: prefers the robot with fewer completed orders over a busier one', () => {
    const orders = [order('o1', { createdAt: 1 })];
    const robots = [robot('busy'), robot('fresh')];
    const plan = planAssignments({
      strategyName: 'least_busy',
      orders,
      robots,
      coordinator: fakeCoordinator(),
      context: { completedCounts: new Map([['busy', 10], ['fresh', 0]]) },
    });
    expect(plan).toEqual([{ orderId: 'o1', robotId: 'fresh' }]);
  });

  it('round_robin: distributes several orders evenly across the fleet in one pass', () => {
    const orders = [
      order('o1', { createdAt: 1 }),
      order('o2', { createdAt: 2 }),
      order('o3', { createdAt: 3 }),
    ];
    const robots = [robot('r1'), robot('r2'), robot('r3')];
    const context = { cursor: 0 };
    const plan = planAssignments({ strategyName: 'round_robin', orders, robots, coordinator: fakeCoordinator(), context });

    expect(plan.map((p) => p.robotId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('round_robin: cursor persists correctly across separate planning calls', () => {
    const robots = [robot('r1'), robot('r2')];
    const context = { cursor: 0 };

    planAssignments({
      strategyName: 'round_robin',
      orders: [order('o1', { createdAt: 1 })],
      robots,
      coordinator: fakeCoordinator(),
      context,
    });
    expect(context.cursor).toBe(1); // r1 was used, next should be r2

    const plan2 = planAssignments({
      strategyName: 'round_robin',
      orders: [order('o2', { createdAt: 1 })],
      robots,
      coordinator: fakeCoordinator(),
      context,
    });
    expect(plan2).toEqual([{ orderId: 'o2', robotId: 'r2' }]);
  });

  it('skips robots already on an order according to the coordinator', () => {
    const orders = [order('o1', { createdAt: 1 })];
    const robots = [robot('busy-on-order'), robot('free')];
    const plan = planAssignments({
      strategyName: 'fcfs',
      orders,
      robots,
      coordinator: fakeCoordinator(['busy-on-order']),
      context: {},
    });
    expect(plan).toEqual([{ orderId: 'o1', robotId: 'free' }]);
  });

  it('stops planning once robots run out, leaving remaining orders unassigned', () => {
    const orders = [order('o1', { createdAt: 1 }), order('o2', { createdAt: 2 })];
    const robots = [robot('only')];
    const plan = planAssignments({
      strategyName: 'fcfs',
      orders,
      robots,
      coordinator: fakeCoordinator(),
      context: {},
    });
    expect(plan).toEqual([{ orderId: 'o1', robotId: 'only' }]);
  });

  it('ignores robots that are not idle', () => {
    const orders = [order('o1', { createdAt: 1 })];
    const robots = [robot('moving-robot', { status: 'moving' }), robot('idle-robot')];
    const plan = planAssignments({
      strategyName: 'fcfs',
      orders,
      robots,
      coordinator: fakeCoordinator(),
      context: {},
    });
    expect(plan).toEqual([{ orderId: 'o1', robotId: 'idle-robot' }]);
  });
});

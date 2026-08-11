const { DynamicObstacleManager, OBSTACLE_TYPES } = require('../../src/engine/obstacles/dynamicObstacles');

describe('DynamicObstacleManager.add', () => {
  it('adds an obstacle and returns its snapshot', () => {
    const manager = new DynamicObstacleManager();
    const snapshot = manager.add({ id: 'o1', type: 'human_worker', cells: [{ x: 2, y: 2 }] });
    expect(snapshot).toMatchObject({ id: 'o1', type: 'human_worker', cells: [{ x: 2, y: 2 }] });
  });

  it('supports all 4 named obstacle types', () => {
    const manager = new DynamicObstacleManager();
    OBSTACLE_TYPES.forEach((type, i) => {
      const snapshot = manager.add({ id: `o${i}`, type, cells: [{ x: i, y: 0 }] });
      expect(snapshot.type).toBe(type);
    });
  });

  it('rejects an unknown obstacle type', () => {
    const manager = new DynamicObstacleManager();
    expect(() => manager.add({ id: 'o1', type: 'bogus', cells: [{ x: 0, y: 0 }] })).toThrow(/type must be one of/);
  });

  it('rejects a duplicate id', () => {
    const manager = new DynamicObstacleManager();
    manager.add({ id: 'o1', type: 'temporary_obstacle', cells: [{ x: 0, y: 0 }] });
    expect(() => manager.add({ id: 'o1', type: 'temporary_obstacle', cells: [{ x: 1, y: 1 }] })).toThrow(/already exists/);
  });

  it('rejects an empty or missing cells array', () => {
    const manager = new DynamicObstacleManager();
    expect(() => manager.add({ id: 'o1', type: 'temporary_obstacle', cells: [] })).toThrow(/non-empty array/);
    expect(() => manager.add({ id: 'o2', type: 'temporary_obstacle' })).toThrow(/non-empty array/);
  });

  it('supports multi-cell obstacles (e.g. a construction zone)', () => {
    const manager = new DynamicObstacleManager();
    const cells = [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 1 }, { x: 2, y: 2 }];
    manager.add({ id: 'zone', type: 'construction_zone', cells });
    for (const c of cells) expect(manager.isBlocked(c.x, c.y)).toBe(true);
  });
});

describe('DynamicObstacleManager.isBlocked', () => {
  it('is false for any cell with no obstacle', () => {
    const manager = new DynamicObstacleManager();
    expect(manager.isBlocked(5, 5)).toBe(false);
  });

  it('is true only for cells actually covered by an obstacle', () => {
    const manager = new DynamicObstacleManager();
    manager.add({ id: 'o1', type: 'human_worker', cells: [{ x: 3, y: 3 }] });
    expect(manager.isBlocked(3, 3)).toBe(true);
    expect(manager.isBlocked(3, 4)).toBe(false);
  });
});

describe('DynamicObstacleManager.remove / get / getAll', () => {
  it('removes an obstacle and frees its cells', () => {
    const manager = new DynamicObstacleManager();
    manager.add({ id: 'o1', type: 'human_worker', cells: [{ x: 1, y: 1 }] });
    expect(manager.remove('o1')).toBe(true);
    expect(manager.isBlocked(1, 1)).toBe(false);
    expect(manager.get('o1')).toBeNull();
  });

  it('returns false removing an obstacle that does not exist', () => {
    const manager = new DynamicObstacleManager();
    expect(manager.remove('ghost')).toBe(false);
  });

  it('getAll lists every active obstacle', () => {
    const manager = new DynamicObstacleManager();
    manager.add({ id: 'o1', type: 'human_worker', cells: [{ x: 0, y: 0 }] });
    manager.add({ id: 'o2', type: 'construction_zone', cells: [{ x: 1, y: 0 }] });
    expect(manager.getAll().map((o) => o.id).sort()).toEqual(['o1', 'o2']);
  });
});

describe('DynamicObstacleManager.tick', () => {
  it('permanent obstacles (no duration) never expire', () => {
    const manager = new DynamicObstacleManager();
    manager.add({ id: 'o1', type: 'construction_zone', cells: [{ x: 0, y: 0 }] });
    const expired = manager.tick(1000);
    expect(expired).toEqual([]);
    expect(manager.isBlocked(0, 0)).toBe(true);
  });

  it('a timed obstacle expires and is removed once its duration elapses', () => {
    const manager = new DynamicObstacleManager();
    manager.add({ id: 'o1', type: 'human_worker', cells: [{ x: 0, y: 0 }], durationSeconds: 5 });

    expect(manager.tick(3)).toEqual([]);
    expect(manager.isBlocked(0, 0)).toBe(true); // 2s remaining

    expect(manager.tick(3)).toEqual(['o1']); // pushed past 0
    expect(manager.isBlocked(0, 0)).toBe(false);
    expect(manager.get('o1')).toBeNull();
  });

  it('only expires the obstacles whose timer actually ran out', () => {
    const manager = new DynamicObstacleManager();
    manager.add({ id: 'short', type: 'human_worker', cells: [{ x: 0, y: 0 }], durationSeconds: 2 });
    manager.add({ id: 'long', type: 'human_worker', cells: [{ x: 1, y: 0 }], durationSeconds: 20 });

    const expired = manager.tick(5);
    expect(expired).toEqual(['short']);
    expect(manager.get('long')).not.toBeNull();
  });
});

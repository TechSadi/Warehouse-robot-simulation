import { describe, it, expect } from 'vitest';
import {
  simulationReducer,
  INITIAL_SERVER_STATE,
  summarizeOrders,
  summarizeRobots,
  utilizationOf,
} from '../../src/state/simulationReducer.js';

const robot = (id, overrides = {}) => ({
  id,
  name: `Robot ${id}`,
  status: 'idle',
  battery: 100,
  position: { x: 0, y: 0 },
  ...overrides,
});

function reduce(actions, initial = INITIAL_SERVER_STATE) {
  return actions.reduce(simulationReducer, initial);
}

describe('simulationReducer', () => {
  it('starts with nothing, and knows it has never heard from the server', () => {
    expect(INITIAL_SERVER_STATE.robots).toEqual([]);
    expect(INITIAL_SERVER_STATE.syncedAt).toBeNull();
    expect(INITIAL_SERVER_STATE.hasSocketSync).toBe(false);
  });

  describe('snapshot vs sync precedence', () => {
    it('applies a REST snapshot when no socket sync has arrived', () => {
      const state = reduce([
        { type: 'snapshot', robots: [robot('r1')], orders: [{ _id: 'o1' }], obstacles: [], at: 1 },
      ]);

      expect(state.robots).toHaveLength(1);
      expect(state.orders).toHaveLength(1);
      expect(state.syncedAt).toBe(1);
    });

    it('refuses to let a late REST snapshot overwrite a socket sync', () => {
      // The race this prevents: the initial REST fetch and the socket's join
      // response are both in flight; if the slower REST reply wins, every
      // robot visibly rewinds to where Mongo last had it.
      const state = reduce([
        { type: 'sync', robots: [robot('r1', { position: { x: 5, y: 5 } })], running: true, at: 2 },
        { type: 'snapshot', robots: [robot('r1', { position: { x: 0, y: 0 } })], orders: [], obstacles: [], at: 1 },
      ]);

      expect(state.robots[0].position).toEqual({ x: 5, y: 5 });
      expect(state.isRunning).toBe(true);
    });

    it('still takes the orders half of a late snapshot, which a sync never carries', () => {
      const state = reduce([
        { type: 'sync', robots: [robot('r1')], running: false, at: 2 },
        { type: 'snapshot', robots: [], orders: [{ _id: 'o1' }], obstacles: [], at: 1 },
      ]);

      expect(state.robots).toHaveLength(1);
      expect(state.orders).toEqual([{ _id: 'o1' }]);
    });
  });

  describe('robot updates', () => {
    it('merges a partial robots:changed without dropping robots it did not mention', () => {
      const state = reduce([
        { type: 'sync', robots: [robot('r1'), robot('r2')], at: 1 },
        { type: 'robots/changed', robots: [{ id: 'r2', status: 'moving' }], at: 2 },
      ]);

      expect(state.robots).toHaveLength(2);
      expect(state.robots.find((r) => r.id === 'r2').status).toBe('moving');
      // The untouched robot keeps every field, not just the ones in the event.
      expect(state.robots.find((r) => r.id === 'r1').battery).toBe(100);
    });

    it('adds a robot it has never seen before', () => {
      const state = reduce([
        { type: 'sync', robots: [robot('r1')], at: 1 },
        { type: 'robots/changed', robots: [robot('r2')], at: 2 },
      ]);

      expect(state.robots.map((r) => r.id)).toEqual(['r1', 'r2']);
    });

    it('removes a deleted robot', () => {
      const state = reduce([
        { type: 'sync', robots: [robot('r1'), robot('r2')], at: 1 },
        { type: 'robots/removed', robotId: 'r1', at: 2 },
      ]);

      expect(state.robots.map((r) => r.id)).toEqual(['r2']);
    });

    it('replaces rather than merges on a resync, so state deleted during an outage disappears', () => {
      // The whole point of a resync: whatever accumulated locally may be
      // wrong. A robot deleted while we were disconnected is never mentioned
      // by any future event, so merging would keep it on screen forever.
      const state = reduce([
        { type: 'sync', robots: [robot('r1'), robot('r2')], at: 1 },
        { type: 'sync', robots: [robot('r2')], at: 2 },
      ]);

      expect(state.robots.map((r) => r.id)).toEqual(['r2']);
    });

    it('ignores an empty robots:changed rather than clearing the fleet', () => {
      const before = reduce([{ type: 'sync', robots: [robot('r1')], at: 1 }]);
      const after = simulationReducer(before, { type: 'robots/changed', robots: [], at: 2 });

      expect(after.robots).toBe(before.robots);
    });
  });

  describe('run status', () => {
    it("takes the server's word for whether the simulation is running", () => {
      const state = reduce([
        { type: 'simulation/optimistic', running: true },
        { type: 'simulation/status', running: false },
      ]);

      expect(state.isRunning).toBe(false);
    });

    it('carries the running flag from a sync', () => {
      expect(reduce([{ type: 'sync', running: true, at: 1 }]).isRunning).toBe(true);
    });
  });

  describe('warehouse deletion', () => {
    it('clears everything and records that the warehouse is gone', () => {
      const state = reduce([
        { type: 'sync', robots: [robot('r1')], obstacles: [{ id: 'o1' }], running: true, at: 1 },
        { type: 'warehouse/deleted' },
      ]);

      expect(state.robots).toEqual([]);
      expect(state.obstacles).toEqual([]);
      expect(state.isRunning).toBe(false);
      expect(state.deleted).toBe(true);
    });

    it('a later sync clears the deleted flag, so a recreated warehouse is usable', () => {
      const state = reduce([
        { type: 'warehouse/deleted' },
        { type: 'sync', robots: [], obstacles: [], running: false, at: 3 },
      ]);

      expect(state.deleted).toBe(false);
    });
  });

  it('resets to the initial state when switching warehouses', () => {
    const state = reduce([
      { type: 'sync', robots: [robot('r1')], running: true, at: 1 },
      { type: 'reset' },
    ]);

    expect(state).toEqual(INITIAL_SERVER_STATE);
  });

  it('ignores actions it does not know, returning the same object', () => {
    const before = reduce([{ type: 'sync', robots: [robot('r1')], at: 1 }]);
    expect(simulationReducer(before, { type: 'nonsense' })).toBe(before);
  });
});

describe('derived summaries', () => {
  it('counts robots by status and averages their battery', () => {
    const summary = summarizeRobots([
      robot('r1', { status: 'moving', battery: 80 }),
      robot('r2', { status: 'moving', battery: 40 }),
      robot('r3', { status: 'error', battery: 10 }),
    ]);

    expect(summary.counts).toMatchObject({ moving: 2, error: 1, idle: 0, charging: 0 });
    expect(summary.avgBattery).toBeCloseTo(43.33, 1);
    expect(summary.lowBattery).toBe(1);
    expect(summary.total).toBe(3);
  });

  it('reports zeroes rather than NaN for an empty fleet', () => {
    const summary = summarizeRobots([]);

    expect(summary.avgBattery).toBe(0);
    expect(summary.counts.idle).toBe(0);
    expect(utilizationOf(summary.counts, summary.total)).toBe(0);
  });

  it('counts every order status, including ones not currently present', () => {
    const counts = summarizeOrders([{ status: 'pending' }, { status: 'delivered' }, { status: 'delivered' }]);

    expect(counts).toEqual({ pending: 1, assigned: 0, picked_up: 0, delivered: 2, cancelled: 0 });
  });

  it('treats moving and charging robots as utilised', () => {
    const { counts, total } = summarizeRobots([
      robot('r1', { status: 'moving' }),
      robot('r2', { status: 'charging' }),
      robot('r3', { status: 'idle' }),
      robot('r4', { status: 'idle' }),
    ]);

    expect(utilizationOf(counts, total)).toBe(50);
  });
});

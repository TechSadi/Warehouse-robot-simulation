import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../src/api/client.js', () => ({
  findRoute: vi.fn(),
  refreshSession: vi.fn(async () => true),
}));

const api = await import('../../src/api/client.js');
const { usePathVisualization } = await import('../../src/state/usePathVisualization.js');

const WAREHOUSE = 'w1';

function traceOf(count, { found = true } = {}) {
  return {
    found,
    cost: 4,
    nodesExplored: count,
    executionTimeMs: 1.23,
    path: found ? [{ x: 0, y: 0 }, { x: 1, y: 0 }] : [],
    steps: Array.from({ length: count }, (_, i) => ({
      current: { x: i, y: 0, g: i, h: 1, f: i + 1 },
      openSet: [],
      closedSet: [],
    })),
  };
}

describe('usePathVisualization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.findRoute.mockResolvedValue(traceOf(3));
  });

  describe('picking cells', () => {
    it('consumes a canvas click while picking, and releases it otherwise', () => {
      const { result } = renderHook(() => usePathVisualization(WAREHOUSE));

      // Not picking: the click belongs to the grid-editing tool.
      expect(result.current.handlePickClick(1, 1)).toBe(false);

      act(() => result.current.pickStart());
      let consumed;
      act(() => {
        consumed = result.current.handlePickClick(2, 3);
      });

      expect(consumed).toBe(true);
      expect(result.current.start).toEqual({ x: 2, y: 3 });
      expect(result.current.pickMode).toBeNull();
    });

    it('cancels pick mode without setting a cell', () => {
      const { result } = renderHook(() => usePathVisualization(WAREHOUSE));

      act(() => result.current.pickGoal());
      act(() => result.current.cancelPick());

      expect(result.current.pickMode).toBeNull();
      expect(result.current.goal).toBeNull();
    });

    it('clears a chosen cell', () => {
      const { result } = renderHook(() => usePathVisualization(WAREHOUSE));
      act(() => result.current.pickStart());
      act(() => result.current.handlePickClick(1, 1));

      act(() => result.current.clearStart());

      expect(result.current.start).toBeNull();
    });
  });

  describe('running a search', () => {
    it('does nothing without both endpoints', async () => {
      const { result } = renderHook(() => usePathVisualization(WAREHOUSE));

      await act(async () => {
        await result.current.run();
      });

      expect(api.findRoute).not.toHaveBeenCalled();
    });

    it('requests a full trace and parks on the first step', async () => {
      const { result } = renderHook(() => usePathVisualization(WAREHOUSE));
      act(() => result.current.pickStart());
      act(() => result.current.handlePickClick(0, 0));
      act(() => result.current.pickGoal());
      act(() => result.current.handlePickClick(2, 0));

      await act(async () => {
        await result.current.run();
      });

      expect(api.findRoute).toHaveBeenCalledWith(
        WAREHOUSE,
        expect.objectContaining({ trace: true, heuristic: 'manhattan', allowDiagonal: false })
      );
      expect(result.current.totalSteps).toBe(3);
      expect(result.current.stepIndex).toBe(0);
      expect(result.current.currentStep).toMatchObject({ current: { x: 0 } });
    });

    it('reports a failed search as a readable message and clears any old trace', async () => {
      api.findRoute.mockRejectedValue(Object.assign(new Error('Request failed: 400'), { status: 400 }));
      const { result } = renderHook(() => usePathVisualization(WAREHOUSE));
      act(() => result.current.pickStart());
      act(() => result.current.handlePickClick(0, 0));
      act(() => result.current.pickGoal());
      act(() => result.current.handlePickClick(2, 0));

      await act(async () => {
        await result.current.run();
      });

      expect(result.current.runError).toBeTruthy();
      expect(result.current.totalSteps).toBe(0);
      expect(result.current.result).toBeNull();
    });

    it('keeps a no-path result so the panel can explain it', async () => {
      api.findRoute.mockResolvedValue(traceOf(2, { found: false }));
      const { result } = renderHook(() => usePathVisualization(WAREHOUSE));
      act(() => result.current.pickStart());
      act(() => result.current.handlePickClick(0, 0));
      act(() => result.current.pickGoal());
      act(() => result.current.handlePickClick(2, 0));

      await act(async () => {
        await result.current.run();
      });

      expect(result.current.result.found).toBe(false);
      expect(result.current.totalSteps).toBe(2);
    });
  });

  describe('scrubbing', () => {
    async function withTrace(count = 5) {
      const hook = renderHook(() => usePathVisualization(WAREHOUSE));
      api.findRoute.mockResolvedValue(traceOf(count));
      act(() => hook.result.current.pickStart());
      act(() => hook.result.current.handlePickClick(0, 0));
      act(() => hook.result.current.pickGoal());
      act(() => hook.result.current.handlePickClick(4, 0));
      await act(async () => {
        await hook.result.current.run();
      });
      return hook;
    }

    it('steps forward and backward within bounds', async () => {
      const { result } = await withTrace(3);

      act(() => result.current.stepBackward());
      expect(result.current.stepIndex).toBe(0); // already at the first

      act(() => result.current.stepForward());
      act(() => result.current.stepForward());
      act(() => result.current.stepForward());
      expect(result.current.stepIndex).toBe(2); // clamped to the last
    });

    it('plays through the trace and stops itself at the end', async () => {
      vi.useFakeTimers();
      try {
        const { result } = await withTrace(3);

        act(() => result.current.play());
        expect(result.current.isPlaying).toBe(true);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });

        expect(result.current.stepIndex).toBe(2);
        expect(result.current.isPlaying).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('restarts from the top when Play is pressed at the end', async () => {
      const { result } = await withTrace(3);
      act(() => result.current.stepForward());
      act(() => result.current.stepForward());
      expect(result.current.stepIndex).toBe(2);

      act(() => result.current.play());

      expect(result.current.stepIndex).toBe(0);
      act(() => result.current.pause());
    });

    it('stepping manually pauses playback', async () => {
      const { result } = await withTrace(5);
      act(() => result.current.play());

      act(() => result.current.stepForward());

      expect(result.current.isPlaying).toBe(false);
    });

    it('clears everything on reset', async () => {
      const { result } = await withTrace(3);

      act(() => result.current.reset());

      expect(result.current.totalSteps).toBe(0);
      expect(result.current.result).toBeNull();
      expect(result.current.stepIndex).toBe(-1);
      expect(result.current.isPlaying).toBe(false);
    });
  });

  it('discards the trace when the synced warehouse changes', async () => {
    const { result, rerender } = renderHook(({ id }) => usePathVisualization(id), {
      initialProps: { id: 'w1' },
    });
    act(() => result.current.pickStart());
    act(() => result.current.handlePickClick(0, 0));
    act(() => result.current.pickGoal());
    act(() => result.current.handlePickClick(2, 0));
    await act(async () => {
      await result.current.run();
    });
    expect(result.current.totalSteps).toBe(3);

    // The trace describes a grid that is no longer on screen.
    rerender({ id: 'w2' });

    expect(result.current.totalSteps).toBe(0);
  });

  it('drops a trace that arrives after the user cleared the panel', async () => {
    let resolveRun;
    api.findRoute.mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));
    const { result } = renderHook(() => usePathVisualization(WAREHOUSE));
    act(() => result.current.pickStart());
    act(() => result.current.handlePickClick(0, 0));
    act(() => result.current.pickGoal());
    act(() => result.current.handlePickClick(2, 0));

    let pending;
    act(() => {
      pending = result.current.run();
    });
    act(() => result.current.reset());

    await act(async () => {
      resolveRun(traceOf(4));
      await pending;
    });

    await waitFor(() => expect(result.current.totalSteps).toBe(0));
  });
});

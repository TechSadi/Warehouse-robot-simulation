import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('../../src/api/client.js', () => ({
  getHealth: vi.fn(),
  refreshSession: vi.fn(async () => true),
}));

const listeners = new Set();
const state = { current: { status: 'idle', attempts: 0, error: null } };

vi.mock('../../src/api/realtime.js', async () => {
  const actual = await vi.importActual('../../src/api/realtime.js');
  return {
    ...actual,
    realtime: {
      getState: () => state.current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
});

const api = await import('../../src/api/client.js');
const { useApiHealth, useRealtimeStatus, describeRealtime, isLive, API_HEALTH } = await import(
  '../../src/state/useConnection.js'
);
const { CONNECTION } = await import('../../src/api/realtime.js');

function pushRealtimeState(next) {
  state.current = next;
  act(() => {
    for (const listener of listeners) listener(next);
  });
}

describe('useRealtimeStatus', () => {
  beforeEach(() => {
    listeners.clear();
    state.current = { status: 'idle', attempts: 0, error: null };
  });

  it('reflects the connection manager and re-renders when it changes', () => {
    const { result } = renderHook(() => useRealtimeStatus());
    expect(result.current.status).toBe(CONNECTION.IDLE);

    pushRealtimeState({ status: CONNECTION.CONNECTED, attempts: 0, error: null });

    expect(result.current.status).toBe(CONNECTION.CONNECTED);
  });

  it('unsubscribes on unmount rather than leaking a listener per mount', () => {
    const { unmount } = renderHook(() => useRealtimeStatus());
    expect(listeners.size).toBe(1);

    unmount();

    expect(listeners.size).toBe(0);
  });
});

describe('describeRealtime', () => {
  it('gives every lifecycle state a label, a tone and an explanation', () => {
    for (const status of Object.values(CONNECTION)) {
      const described = describeRealtime({ status, attempts: 0 });
      expect(described.label).toBeTruthy();
      expect(['online', 'pending', 'offline']).toContain(described.tone);
      expect(described.detail).toBeTruthy();
    }
  });

  it('mentions the attempt count once retrying has gone on for a while', () => {
    expect(describeRealtime({ status: CONNECTION.RECONNECTING, attempts: 4 }).detail).toMatch(/attempt 4/);
  });

  it('treats only connected and reconnected as able to carry a command', () => {
    expect(isLive({ status: CONNECTION.CONNECTED })).toBe(true);
    expect(isLive({ status: CONNECTION.RECONNECTED })).toBe(true);
    expect(isLive({ status: CONNECTION.RECONNECTING })).toBe(false);
    expect(isLive({ status: CONNECTION.DISCONNECTED })).toBe(false);
    expect(isLive({ status: CONNECTION.UNAUTHORIZED })).toBe(false);
  });
});

describe('useApiHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getHealth.mockResolvedValue({ status: 'ok' });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('stays in "checking" and makes no requests while disabled', () => {
    const { result } = renderHook(() => useApiHealth(false));

    expect(result.current.health).toBe(API_HEALTH.CHECKING);
    expect(api.getHealth).not.toHaveBeenCalled();
  });

  it('reports online once the health endpoint answers', async () => {
    const { result } = renderHook(() => useApiHealth(true));

    await waitFor(() => expect(result.current.health).toBe(API_HEALTH.ONLINE));
  });

  it('reports offline when the API cannot be reached', async () => {
    api.getHealth.mockRejectedValue(Object.assign(new Error('Network request failed'), { status: 0 }));

    const { result } = renderHook(() => useApiHealth(true));

    await waitFor(() => expect(result.current.health).toBe(API_HEALTH.OFFLINE));
  });

  it('polls on an interval', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useApiHealth(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(api.getHealth).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000);
      });

      expect(api.getHealth).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stack probes when one is slow', async () => {
    let resolveProbe;
    api.getHealth.mockReturnValue(new Promise((resolve) => { resolveProbe = resolve; }));
    const { result } = renderHook(() => useApiHealth(true));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      result.current.recheck();
      result.current.recheck();
    });

    expect(api.getHealth).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveProbe({ status: 'ok' });
    });
  });

  it('stops polling while the tab is hidden and re-checks on return', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useApiHealth(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      api.getHealth.mockClear();

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000);
      });
      expect(api.getHealth).not.toHaveBeenCalled();

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      act(() => document.dispatchEvent(new Event('visibilitychange')));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(api.getHealth).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the interval on unmount', async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderHook(() => useApiHealth(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      api.getHealth.mockClear();

      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60000);
      });

      expect(api.getHealth).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

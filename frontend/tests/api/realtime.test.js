import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRealtimeClient, CONNECTION } from '../../src/api/realtime.js';
import { createFakeSocket } from '../helpers/fakeSocket.js';

function setup({ refresh } = {}) {
  const socket = createFakeSocket();
  const refreshFn = refresh || vi.fn(async () => true);
  const client = createRealtimeClient({ socket, refresh: refreshFn, settleMs: 10 });
  return { socket, client, refresh: refreshFn };
}

describe('realtime lifecycle', () => {
  it('starts idle and moves to connecting only when asked', () => {
    const { socket, client } = setup();
    expect(client.getState().status).toBe(CONNECTION.IDLE);
    expect(socket.connect).not.toHaveBeenCalled();

    client.connect();

    expect(client.getState().status).toBe(CONNECTION.CONNECTING);
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('walks connecting -> connected -> disconnected -> reconnecting -> reconnected', () => {
    const { socket, client } = setup();
    const seen = [];
    client.subscribe((state) => seen.push(state.status));

    client.connect();
    socket.completeConnect();
    expect(client.getState().status).toBe(CONNECTION.CONNECTED);

    socket.dropConnection('transport close');
    expect(client.getState().status).toBe(CONNECTION.DISCONNECTED);

    socket.fireManager('reconnect_attempt', 1);
    expect(client.getState().status).toBe(CONNECTION.RECONNECTING);

    socket.completeConnect();
    // A connect after a previous connection is a *re*connect, and says so -
    // "connected" would hide the fact that state had to be resynchronised.
    expect(client.getState().status).toBe(CONNECTION.RECONNECTED);

    expect(seen).toEqual([
      CONNECTION.CONNECTING,
      CONNECTION.CONNECTED,
      CONNECTION.DISCONNECTED,
      CONNECTION.RECONNECTING,
      CONNECTION.RECONNECTED,
    ]);
  });

  it('settles reconnected back to connected', async () => {
    vi.useFakeTimers();
    try {
      const { socket, client } = setup();
      client.connect();
      socket.completeConnect();
      socket.dropConnection();
      socket.completeConnect();

      expect(client.getState().status).toBe(CONNECTION.RECONNECTED);
      vi.advanceTimersByTime(50);
      expect(client.getState().status).toBe(CONNECTION.CONNECTED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts reconnection attempts so the UI can say how long it has been trying', () => {
    const { socket, client } = setup();
    client.connect();
    socket.completeConnect();
    socket.dropConnection();

    socket.fireManager('reconnect_attempt', 1);
    socket.fireManager('reconnect_attempt', 2);
    socket.fireManager('reconnect_attempt', 3);

    expect(client.getState().attempts).toBe(3);
  });

  it('resets the attempt counter once it gets back in', () => {
    const { socket, client } = setup();
    client.connect();
    socket.failConnect('xhr poll error');
    socket.failConnect('xhr poll error');
    expect(client.getState().attempts).toBe(2);

    socket.completeConnect();
    expect(client.getState().attempts).toBe(0);
  });

  it('reconnects itself when the server closes the socket deliberately', () => {
    const { socket, client } = setup();
    client.connect();
    socket.completeConnect();
    socket.connect.mockClear();

    // socket.io does not auto-retry this reason, so the client must.
    socket.dropConnection('io server disconnect');

    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('treats a deliberate local disconnect as idle, not as a failure to retry', () => {
    const { socket, client } = setup();
    client.connect();
    socket.completeConnect();

    client.disconnect();

    expect(client.getState().status).toBe(CONNECTION.IDLE);
    expect(socket.disconnect).toHaveBeenCalled();
  });
});

describe('realtime room registry', () => {
  it('joins a room immediately when already connected', () => {
    const { socket, client } = setup();
    client.connect();
    socket.completeConnect();
    socket.clearEmitted();

    client.joinWarehouse('w1');

    expect(socket.emitsOf('warehouse:join')).toEqual([{ event: 'warehouse:join', payload: 'w1' }]);
  });

  it('rejoins every registered room on reconnect, exactly once each', () => {
    const { socket, client } = setup();
    client.connect();
    socket.completeConnect();
    client.joinWarehouse('w1');
    client.joinWarehouse('w2');
    socket.clearEmitted();

    socket.dropConnection();
    socket.completeConnect();

    expect(socket.emitsOf('warehouse:join').map((e) => e.payload)).toEqual(['w1', 'w2']);
  });

  it('joins once for two subscribers to the same warehouse', () => {
    const { socket, client } = setup();
    client.connect();
    socket.completeConnect();
    socket.clearEmitted();

    const leaveA = client.joinWarehouse('w1');
    const leaveB = client.joinWarehouse('w1');

    expect(socket.emitsOf('warehouse:join')).toHaveLength(1);

    // The first release must not deafen the second subscriber.
    leaveA();
    expect(socket.emitsOf('warehouse:leave')).toHaveLength(0);
    expect(client.getRooms()).toEqual(['w1']);

    leaveB();
    expect(socket.emitsOf('warehouse:leave')).toHaveLength(1);
    expect(client.getRooms()).toEqual([]);
  });

  it('releasing twice is harmless', () => {
    const { socket, client } = setup();
    client.connect();
    socket.completeConnect();
    const leave = client.joinWarehouse('w1');
    socket.clearEmitted();

    leave();
    leave();

    expect(socket.emitsOf('warehouse:leave')).toHaveLength(1);
  });

  it('registers a room while offline and joins it when the connection arrives', () => {
    const { socket, client } = setup();
    client.joinWarehouse('w1');
    expect(socket.emitsOf('warehouse:join')).toHaveLength(0);

    client.connect();
    socket.completeConnect();

    expect(socket.emitsOf('warehouse:join').map((e) => e.payload)).toEqual(['w1']);
  });
});

describe('realtime event subscriptions', () => {
  it('removes every handler it registered, so remounting cannot leak listeners', () => {
    const { socket, client } = setup();
    const handlers = {
      'robots:changed': vi.fn(),
      'orders:changed': vi.fn(),
      'simulation:sync': vi.fn(),
    };

    const unsubscribeA = client.on(handlers);
    const unsubscribeB = client.on(handlers);
    expect(socket.listenerCount('robots:changed')).toBe(1); // same fn identity

    unsubscribeA();
    unsubscribeB();

    expect(socket.listenerCount('robots:changed')).toBe(0);
    expect(socket.listenerCount('orders:changed')).toBe(0);
    expect(socket.listenerCount('simulation:sync')).toBe(0);
  });

  it('delivers events to registered handlers', () => {
    const { socket, client } = setup();
    const onRobots = vi.fn();
    client.on({ 'robots:changed': onRobots });

    socket.fire('robots:changed', { warehouseId: 'w1', robots: [] });

    expect(onRobots).toHaveBeenCalledWith({ warehouseId: 'w1', robots: [] });
  });
});

describe('realtime emit gating', () => {
  it('refuses to emit while disconnected instead of buffering the command', () => {
    const { socket, client } = setup();

    const sent = client.emit('simulation:start', { warehouseId: 'w1' });

    expect(sent).toBe(false);
    expect(socket.emitsOf('simulation:start')).toHaveLength(0);
  });

  it('emits once connected', () => {
    const { socket, client } = setup();
    client.connect();
    socket.completeConnect();

    expect(client.emit('simulation:start', { warehouseId: 'w1' })).toBe(true);
    expect(socket.emitsOf('simulation:start')).toHaveLength(1);
  });
});

describe('realtime session recovery', () => {
  it('refreshes the session and reconnects when the handshake says the token expired', async () => {
    const refresh = vi.fn(async () => true);
    const { socket, client } = setup({ refresh });
    client.connect();
    socket.connect.mockClear();

    socket.failConnect('UNAUTHENTICATED');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    // It stops socket.io's retry loop first so the expired cookie is not
    // re-sent while the refresh is in flight.
    expect(socket.disconnect).toHaveBeenCalled();
    await vi.waitFor(() => expect(socket.connect).toHaveBeenCalledTimes(1));
    expect(client.getState().status).toBe(CONNECTION.RECONNECTING);
  });

  it('gives up and reports an unrecoverable session when the refresh fails', async () => {
    const refresh = vi.fn(async () => false);
    const onUnauthorized = vi.fn();
    const { socket, client } = setup({ refresh });
    client.setUnauthorizedHandler(onUnauthorized);
    client.connect();

    socket.failConnect('UNAUTHENTICATED');

    await vi.waitFor(() => expect(client.getState().status).toBe(CONNECTION.UNAUTHORIZED));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(client.getState().error).toMatch(/session/i);
  });

  it('stops refreshing after repeated auth failures rather than looping forever', async () => {
    const refresh = vi.fn(async () => true);
    const { socket, client } = setup({ refresh });
    client.connect();

    socket.failConnect('UNAUTHENTICATED');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    socket.failConnect('UNAUTHENTICATED');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    socket.failConnect('UNAUTHENTICATED');

    await vi.waitFor(() => expect(client.getState().status).toBe(CONNECTION.UNAUTHORIZED));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not try to refresh for an ordinary transport failure', async () => {
    const refresh = vi.fn(async () => true);
    const { socket, client } = setup({ refresh });
    client.connect();

    socket.failConnect('xhr poll error');

    expect(refresh).not.toHaveBeenCalled();
    expect(client.getState().status).toBe(CONNECTION.CONNECTING);
    expect(client.getState().error).toBe('xhr poll error');
  });

  it('clears the auth-recovery budget after a successful connect', async () => {
    const refresh = vi.fn(async () => true);
    const { socket, client } = setup({ refresh });
    client.connect();

    socket.failConnect('UNAUTHENTICATED');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    socket.completeConnect();

    socket.failConnect('UNAUTHENTICATED');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(client.getState().status).not.toBe(CONNECTION.UNAUTHORIZED);
  });
});

describe('realtime and the browser going offline', () => {
  function goOffline() {
    window.dispatchEvent(new Event('offline'));
  }
  function goOnline() {
    window.dispatchEvent(new Event('online'));
  }

  it('reports the drop immediately rather than waiting for a heartbeat to time out', () => {
    const { socket, client } = setup();
    client.connect();
    socket.completeConnect();

    goOffline();

    // An open socket whose network vanishes is not closed, so socket.io
    // would not notice for up to pingInterval + pingTimeout. The browser
    // already knows.
    expect(client.getState().status).toBe(CONNECTION.DISCONNECTED);
    expect(client.getState().error).toMatch(/offline/i);
  });

  it('nudges the socket back when the network returns', () => {
    const { socket, client } = setup();
    client.connect();
    socket.completeConnect();
    goOffline();
    socket.connected = false;
    socket.connect.mockClear();

    goOnline();

    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(client.getState().status).toBe(CONNECTION.RECONNECTING);
  });

  it('recovers the status when the socket outlived the outage', () => {
    // The case that made the first end-to-end offline run hang: a short
    // outage that the WebSocket survives. socket.io never disconnects, so it
    // will never fire `connect` either - without this, the `disconnected`
    // status set on `offline` would stick forever while updates streamed in
    // behind it.
    const { socket, client } = setup();
    client.connect();
    socket.completeConnect();
    client.joinWarehouse('w1');
    goOffline();
    expect(client.getState().status).toBe(CONNECTION.DISCONNECTED);
    socket.clearEmitted();
    socket.connect.mockClear();

    goOnline();

    expect(client.getState().status).toBe(CONNECTION.RECONNECTED);
    // No new handshake was needed, but the rooms are rejoined so the server
    // resends what was missed during the gap.
    expect(socket.connect).not.toHaveBeenCalled();
    expect(socket.emitsOf('warehouse:join').map((e) => e.payload)).toEqual(['w1']);
  });

  it('leaves a deliberately closed connection closed', () => {
    const { socket, client } = setup();
    client.connect();
    socket.completeConnect();
    client.disconnect();
    socket.connect.mockClear();

    goOffline();
    goOnline();

    expect(socket.connect).not.toHaveBeenCalled();
    expect(client.getState().status).toBe(CONNECTION.IDLE);
  });

  it('does not paper over an expired session with a network message', async () => {
    const { socket, client } = setup({ refresh: vi.fn(async () => false) });
    client.connect();
    socket.failConnect('UNAUTHENTICATED');
    await vi.waitFor(() => expect(client.getState().status).toBe(CONNECTION.UNAUTHORIZED));

    goOffline();

    // "Sign in again" is the actionable message; "you went offline" is not.
    expect(client.getState().status).toBe(CONNECTION.UNAUTHORIZED);
  });
});

describe('realtime state subscriptions', () => {
  let socket;
  let client;

  beforeEach(() => {
    ({ socket, client } = setup());
  });

  it('does not notify subscribers when nothing changed', () => {
    const listener = vi.fn();
    client.subscribe(listener);

    client.connect();
    socket.completeConnect();
    listener.mockClear();

    // Data events carry no lifecycle change, and a repeated retry at the
    // same attempt number is the same state described twice. Neither should
    // re-render anything subscribed to the connection.
    socket.fire('robots:changed', {});
    socket.dropConnection();
    listener.mockClear();
    socket.fireManager('reconnect_attempt', 1);
    listener.mockClear();
    socket.fireManager('reconnect_attempt', 1);

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    unsubscribe();

    client.connect();

    expect(listener).not.toHaveBeenCalled();
  });
});

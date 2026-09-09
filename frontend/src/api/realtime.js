import { io } from 'socket.io-client';
import { refreshSession } from './client.js';

/**
 * The realtime connection, as a lifecycle rather than a socket.
 *
 * The previous design exported a bare socket.io client and let every
 * consumer improvise around it. That left three problems that only show up
 * on a bad network, which is exactly when they matter:
 *
 *  1. **The session could expire out from under the socket.** The
 *     handshake is authenticated once, at connect time, from the httpOnly
 *     access cookie - which lives 15 minutes (backend/src/config/env.js).
 *     socket.io reconnects on its own and re-sends the *same* expired
 *     cookie, so the server rejects it, so socket.io retries, forever.
 *     REST kept working (it refreshes on a 401), so the app looked alive
 *     while the live view silently stopped updating. Recovery here means
 *     refreshing the session and then reconnecting - the socket equivalent
 *     of the client's 401 retry, sharing the same serialised refresh so
 *     the two can never rotate the refresh token twice in parallel.
 *
 *  2. **Rejoining rooms was the data hook's job.** Every consumer that
 *     cared about a warehouse had to remember to re-emit `warehouse:join`
 *     on every `connect`, because the server drops room membership on
 *     disconnect and its broadcasts are fire-and-forget, not a replayable
 *     stream. One forgotten listener meant a permanently stale panel. The
 *     room registry below makes rejoining a property of the connection:
 *     whatever is registered gets rejoined, once per room, by one listener.
 *
 *  3. **Nothing could tell the user what was happening.** A socket is
 *     either connected or not, but a person needs to distinguish "still
 *     connecting", "we lost it and are retrying", and "your session
 *     ended, sign in again" - they imply completely different actions.
 *
 * The lifecycle this exposes:
 *
 *     idle -> connecting -> connected
 *                 ^            |
 *                 |            v
 *          reconnecting <- disconnected
 *                 |
 *                 v
 *            reconnected -> connected      (settles after a moment)
 *
 * plus `unauthorized`, a terminal state that only a fresh sign-in leaves.
 */
export const CONNECTION = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  RECONNECTING: 'reconnecting',
  RECONNECTED: 'reconnected',
  UNAUTHORIZED: 'unauthorized',
};

/** How long `reconnected` stays visible before settling to `connected`.
 * Long enough to read, short enough not to look like a stuck state. */
const RECONNECTED_SETTLE_MS = 2500;

/** A handshake can be rejected because the access token expired, which one
 * refresh fixes. If it is still rejected after this many refresh attempts,
 * the session is genuinely gone and retrying is just noise. */
const MAX_AUTH_RECOVERIES = 2;

const AUTH_ERROR_PATTERN = /unauthenticated|unauthorized|invalid token|jwt/i;

/**
 * Builds a lifecycle manager around a socket-like object.
 *
 * The socket and the refresh function are injected so tests can drive the
 * whole state machine - including reconnects and expired sessions - against
 * a stub, without a server, timers, or a real transport.
 *
 * @param {{ socket: any, refresh?: () => Promise<boolean>, settleMs?: number }} options
 */
export function createRealtimeClient({ socket, refresh = refreshSession, settleMs = RECONNECTED_SETTLE_MS }) {
  let state = {
    status: CONNECTION.IDLE,
    /** How many consecutive failed connection attempts. Reset on connect. */
    attempts: 0,
    /** Set while `unauthorized`, or when a connect attempt failed. */
    error: null,
    /** True once a connection has been established at least once, which is
     * what separates a first connect from a reconnect. */
    everConnected: false,
    lastConnectedAt: null,
  };

  const stateListeners = new Set();
  /** warehouseId -> number of live subscribers. Refcounted because two
   * panels watching the same warehouse must produce one join, not two, and
   * one of them unmounting must not leave the other deaf. */
  const rooms = new Map();
  let authRecoveries = 0;
  let settleTimer = null;
  let intentionallyClosed = false;
  let onUnauthorized = null;

  function setState(patch) {
    const next = { ...state, ...patch };
    // Identical state changes nothing; skipping them keeps subscribed
    // components from re-rendering on every retry tick.
    const changed = Object.keys(patch).some((key) => state[key] !== next[key]);
    if (!changed) return;
    state = next;
    for (const listener of stateListeners) listener(state);
  }

  function clearSettleTimer() {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  }

  /** Rejoining every registered room is the whole point of the registry:
   * one listener does it for every consumer, so a reconnect cannot leave
   * some panels subscribed and others silently orphaned. The server answers
   * each join with an authoritative `simulation:sync` burst, which is what
   * actually repairs state after a gap. */
  function rejoinRooms() {
    for (const warehouseId of rooms.keys()) {
      socket.emit('warehouse:join', warehouseId);
    }
  }

  /** `reconnected` is a moment, not a resting state: show it long enough to
   * be read, then settle to plain `connected`. */
  function settleReconnected() {
    clearSettleTimer();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      // Only settle if we are still up - a second drop in the meantime must
      // not be overwritten with a stale "connected".
      if (state.status === CONNECTION.RECONNECTED) setState({ status: CONNECTION.CONNECTED });
    }, settleMs);
  }

  function handleConnect() {
    clearSettleTimer();
    authRecoveries = 0;
    const reconnected = state.everConnected;

    setState({
      status: reconnected ? CONNECTION.RECONNECTED : CONNECTION.CONNECTED,
      attempts: 0,
      error: null,
      everConnected: true,
      lastConnectedAt: Date.now(),
    });

    rejoinRooms();

    if (reconnected) settleReconnected();
  }

  function handleDisconnect(reason) {
    clearSettleTimer();
    if (intentionallyClosed || reason === 'io client disconnect') {
      setState({ status: CONNECTION.IDLE, everConnected: false });
      return;
    }
    setState({ status: CONNECTION.DISCONNECTED, error: null });
    // `io server disconnect` means the server closed us deliberately and
    // socket.io will *not* retry on its own. Everything else is a transport
    // failure it does retry, and `reconnect_attempt` moves us on from here.
    if (reason === 'io server disconnect') socket.connect();
  }

  function handleReconnectAttempt(attempt) {
    setState({ status: CONNECTION.RECONNECTING, attempts: attempt });
  }

  /**
   * A rejected handshake. The only kind worth special handling is an
   * expired session: refresh once, reconnect, and the user never notices.
   * Anything else is an ordinary connection failure that socket.io's own
   * backoff already retries.
   */
  async function handleConnectError(err) {
    const message = err?.message || 'Connection failed';
    const isAuthFailure = AUTH_ERROR_PATTERN.test(message);

    if (!isAuthFailure) {
      setState({
        status: state.everConnected ? CONNECTION.RECONNECTING : CONNECTION.CONNECTING,
        attempts: state.attempts + 1,
        error: message,
      });
      return;
    }

    // Stop socket.io's retry loop before refreshing: left running it would
    // keep re-sending the same expired cookie while we work, spending the
    // server's auth rate limit on requests we already know will fail.
    socket.disconnect();

    if (authRecoveries >= MAX_AUTH_RECOVERIES) {
      setState({ status: CONNECTION.UNAUTHORIZED, error: 'Your session has expired. Sign in again.' });
      if (onUnauthorized) onUnauthorized();
      return;
    }

    authRecoveries += 1;
    setState({ status: CONNECTION.RECONNECTING, attempts: state.attempts + 1, error: null });

    const refreshed = await refresh();
    if (intentionallyClosed) return;

    if (refreshed) {
      socket.connect();
      return;
    }

    setState({ status: CONNECTION.UNAUTHORIZED, error: 'Your session has expired. Sign in again.' });
    if (onUnauthorized) onUnauthorized();
  }

  socket.on('connect', handleConnect);
  socket.on('disconnect', handleDisconnect);
  socket.on('connect_error', handleConnectError);
  // socket.io emits reconnect events on the manager, not the socket. The
  // optional chaining keeps this working against a plain stub socket in tests.
  socket.io?.on?.('reconnect_attempt', handleReconnectAttempt);

  /**
   * The browser knows it is offline long before the socket does.
   *
   * An open WebSocket whose network vanishes is not closed - it just stops
   * carrying traffic - so socket.io only notices when its heartbeat times
   * out, up to `pingInterval + pingTimeout` later. Measured against a real
   * browser with the network cut, that was around 45 seconds of a dashboard
   * confidently labelled "Live" while every robot on it sat frozen. The
   * `offline` event is the browser telling us the answer immediately, and
   * saying so is strictly better than continuing to claim a connection we
   * can already prove is gone.
   *
   * This reports; it does not tear the socket down. If the outage is brief
   * socket.io reconnects on its own, and `online` nudges it rather than
   * forcing a fresh handshake the transport may not need.
   */
  function handleBrowserOffline() {
    if (intentionallyClosed) return;
    if (state.status === CONNECTION.UNAUTHORIZED) return;
    setState({ status: CONNECTION.DISCONNECTED, error: 'This device went offline.' });
  }

  function handleBrowserOnline() {
    if (intentionallyClosed) return;
    if (state.status === CONNECTION.UNAUTHORIZED) return;

    // The socket often outlives a short outage: a WebSocket whose network
    // vanished is not closed, so if the link comes back before the
    // heartbeat gives up, socket.io never disconnected and will never fire
    // `connect` - which means nothing would ever clear the `disconnected`
    // status set above, and the dashboard would sit there claiming to be
    // down while updates streamed in behind it. (This is exactly what
    // happened the first time the end-to-end offline test ran.)
    //
    // Either way, broadcasts made during the gap are gone, so this is a
    // reconnect in every sense that matters: say so, and rejoin the rooms
    // to pull an authoritative snapshot back down.
    if (socket.connected) {
      setState({ status: CONNECTION.RECONNECTED, error: null, lastConnectedAt: Date.now() });
      rejoinRooms();
      settleReconnected();
      return;
    }

    setState({ status: CONNECTION.RECONNECTING, error: null });
    socket.connect();
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('offline', handleBrowserOffline);
    window.addEventListener('online', handleBrowserOnline);
  }

  return {
    /** Current lifecycle snapshot. Never mutated in place, so React can
     * compare it by identity. */
    getState() {
      return state;
    },

    /** Subscribe to lifecycle changes. Returns an unsubscribe function -
     * the caller keeps no other handle, so there is nothing to leak. */
    subscribe(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    /** Called when the session is unrecoverable, so the app can drop to the
     * sign-in screen rather than sit in a state no retry will fix. */
    setUnauthorizedHandler(handler) {
      onUnauthorized = handler;
    },

    isConnected() {
      return Boolean(socket.connected);
    },

    /**
     * Opens the connection with whatever session the browser holds now.
     *
     * The handshake is authenticated once, at connect time - an already-open
     * socket is never re-checked - so after signing in or out an existing
     * connection carries the wrong identity, and has to be torn down rather
     * than reused.
     */
    connect() {
      intentionallyClosed = false;
      authRecoveries = 0;
      clearSettleTimer();
      if (socket.connected) socket.disconnect();
      setState({
        status: CONNECTION.CONNECTING,
        attempts: 0,
        error: null,
        everConnected: false,
      });
      socket.connect();
    },

    /** Closes deliberately (sign-out). Rooms are kept: they describe what
     * the UI is watching, not what the transport happens to be doing, and
     * the next connect rejoins them. */
    disconnect() {
      intentionallyClosed = true;
      clearSettleTimer();
      socket.disconnect();
      setState({ status: CONNECTION.IDLE, attempts: 0, error: null, everConnected: false });
    },

    /**
     * Registers interest in a warehouse's room and returns the matching
     * release function. Refcounted: N subscribers produce one join, and the
     * room is left only when the last of them releases it.
     */
    joinWarehouse(warehouseId) {
      if (!warehouseId) return () => {};
      const id = String(warehouseId);
      const count = rooms.get(id) || 0;
      rooms.set(id, count + 1);
      if (count === 0 && socket.connected) socket.emit('warehouse:join', id);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = rooms.get(id) || 0;
        if (current <= 1) {
          rooms.delete(id);
          if (socket.connected) socket.emit('warehouse:leave', id);
        } else {
          rooms.set(id, current - 1);
        }
      };
    },

    /** The rooms currently registered - exposed for tests and diagnostics. */
    getRooms() {
      return [...rooms.keys()];
    },

    /**
     * Registers a map of event handlers and returns one function that
     * removes every one of them. Registering and unregistering from a
     * single object is what keeps the two lists from drifting apart - the
     * previous code listed fourteen `socket.on` calls and fourteen matching
     * `socket.off` calls by hand, where one typo leaks a listener per mount.
     */
    on(handlers) {
      const entries = Object.entries(handlers).filter(([, fn]) => typeof fn === 'function');
      for (const [event, fn] of entries) socket.on(event, fn);
      return () => {
        for (const [event, fn] of entries) socket.off(event, fn);
      };
    },

    /**
     * Sends an event, and says whether it actually went anywhere.
     *
     * socket.io buffers emits made while disconnected and flushes them on
     * connect, which is the wrong behaviour for simulation controls: a
     * "start" clicked during an outage would fire minutes later, long after
     * the person gave up and clicked it again. Callers get `false` and can
     * tell the user instead.
     */
    emit(event, payload) {
      if (!socket.connected) return false;
      socket.emit(event, payload);
      return true;
    },

    /** Asks the server to re-send its authoritative snapshot. */
    requestSync(warehouseId) {
      return this.emit('simulation:sync', { warehouseId });
    },
  };
}

// Vite's dev server proxies /socket.io to the backend (see vite.config.js),
// so connecting to the current origin works in both dev and a same-origin
// production deployment. For a separately-deployed frontend/backend (this
// project's documented target - see DEPLOYMENT.md), set VITE_SOCKET_URL at
// build time to the backend's deployed origin.
//
// `withCredentials` is what makes the browser attach the httpOnly access
// cookie to the handshake. The server rejects an unauthenticated handshake
// outright (backend/src/sockets/socketAuth.js), so without it the
// connection simply fails cross-origin.
export const socket = io(import.meta.env.VITE_SOCKET_URL || undefined, {
  autoConnect: false,
  path: '/socket.io',
  withCredentials: true,
  // Bounded backoff. The default caps at 5s; a simulation dashboard left
  // open overnight against a restarting backend should not hammer it, but
  // should still recover within a few seconds of it coming back.
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
});

export const realtime = createRealtimeClient({ socket });

import { vi } from 'vitest';

/**
 * A socket.io-client stand-in with the pieces the realtime client actually
 * touches, plus the ability to drive its lifecycle from a test.
 *
 * Mocking the transport rather than the whole realtime module is what makes
 * the reconnect, resync and expired-session paths testable at all: those are
 * state machines driven entirely by socket events, and a mocked realtime
 * client would assert only that the mock was called.
 */
export function createFakeSocket() {
  const handlers = new Map();
  const managerHandlers = new Map();

  const socket = {
    connected: false,
    /** Every emit made, in order - the assertion surface for "did it rejoin
     * the room", "did it send exactly one join", and so on. */
    emitted: [],

    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return socket;
    },

    off(event, handler) {
      handlers.get(event)?.delete(handler);
      return socket;
    },

    emit(event, payload) {
      socket.emitted.push({ event, payload });
      return socket;
    },

    connect: vi.fn(() => {
      socket.connecting = true;
    }),

    disconnect: vi.fn(() => {
      const wasConnected = socket.connected;
      socket.connected = false;
      if (wasConnected) socket.fire('disconnect', 'io client disconnect');
    }),

    io: {
      on(event, handler) {
        if (!managerHandlers.has(event)) managerHandlers.set(event, new Set());
        managerHandlers.get(event).add(handler);
      },
    },

    // --- test drivers ------------------------------------------------------

    /** Invokes every listener registered for `event`. */
    fire(event, ...args) {
      for (const handler of [...(handlers.get(event) || [])]) handler(...args);
    },

    fireManager(event, ...args) {
      for (const handler of [...(managerHandlers.get(event) || [])]) handler(...args);
    },

    /** The server accepted the handshake. */
    completeConnect() {
      socket.connected = true;
      socket.fire('connect');
    },

    /** The transport dropped. `reason` follows socket.io's vocabulary. */
    dropConnection(reason = 'transport close') {
      socket.connected = false;
      socket.fire('disconnect', reason);
    },

    /** The handshake was rejected. */
    failConnect(message = 'UNAUTHENTICATED') {
      socket.connected = false;
      socket.fire('connect_error', new Error(message));
    },

    /** How many handlers are registered for an event - used to prove
     * unsubscribing actually removes them rather than leaking. */
    listenerCount(event) {
      return handlers.get(event)?.size || 0;
    },

    emitsOf(event) {
      return socket.emitted.filter((entry) => entry.event === event);
    },

    clearEmitted() {
      socket.emitted.length = 0;
    },
  };

  return socket;
}

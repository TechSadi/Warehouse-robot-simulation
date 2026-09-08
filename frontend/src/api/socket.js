import { io } from 'socket.io-client';

// Vite's dev server proxies /socket.io to the backend (see vite.config.js),
// so connecting to the current origin works in both dev and a same-origin
// production deployment. For a separately-deployed frontend/backend (this
// project's documented target - see DEPLOYMENT.md), set VITE_SOCKET_URL at
// build time to the backend's deployed origin; left unset, socket.io-client
// connects to the page's own origin exactly as before.
//
// `withCredentials` is what makes the browser attach the httpOnly access
// cookie to the Socket.IO handshake. The server now rejects an
// unauthenticated handshake outright (backend/src/sockets/socketAuth.js),
// so without this the connection simply fails cross-origin.
export const socket = io(import.meta.env.VITE_SOCKET_URL || undefined, {
  autoConnect: false,
  path: '/socket.io',
  withCredentials: true,
});

/**
 * Reconnects with a freshly-minted session.
 *
 * The handshake is authenticated once, at connect time - an already-open
 * socket is not re-checked. After signing in or out the existing
 * connection therefore carries the wrong identity (or none), and has to be
 * torn down rather than reused.
 */
export function reconnectSocket() {
  if (socket.connected) socket.disconnect();
  socket.connect();
}

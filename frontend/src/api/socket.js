import { io } from 'socket.io-client';

// Vite's dev server proxies /socket.io to the backend (see vite.config.js),
// so connecting to the current origin works in both dev and a same-origin
// production deployment. For a separately-deployed frontend/backend (this
// project's documented target - see DEPLOYMENT.md), set VITE_SOCKET_URL at
// build time to the backend's deployed origin; left unset, socket.io-client
// connects to the page's own origin exactly as before.
export const socket = io(import.meta.env.VITE_SOCKET_URL || undefined, {
  autoConnect: false,
  path: '/socket.io',
});

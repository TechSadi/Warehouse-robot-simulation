const cookie = require('cookie');
const { resolveUserFromToken } = require('../middleware/auth');
const { ACCESS_COOKIE } = require('../utils/tokens');

/**
 * Socket.IO connection authentication.
 *
 * The real-time channel used to be entirely open: anyone who could reach
 * the server could connect, join `warehouse:<id>` for any id they cared to
 * guess, and receive that warehouse's live robot positions, order events
 * and notifications - and start or stop its simulation. Socket.IO does not
 * go through Express's middleware stack, so none of the HTTP hardening
 * applied to it; it needs its own handshake gate, using the same token
 * verification the REST side uses (middleware/auth.js) so the two cannot
 * drift apart.
 *
 * Two transports for the token, matching the HTTP side:
 *   - the httpOnly access cookie, sent automatically by the browser when
 *     the client connects with `withCredentials: true`;
 *   - `auth: { token }` in the handshake, for non-browser clients.
 */
function extractHandshakeToken(handshake) {
  const fromAuth = handshake.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) {
    return fromAuth.startsWith('Bearer ') ? fromAuth.slice(7).trim() : fromAuth;
  }

  const header = handshake.headers?.cookie;
  if (header) {
    try {
      const parsed = cookie.parse(header);
      if (parsed[ACCESS_COOKIE]) return parsed[ACCESS_COOKIE];
    } catch {
      // A malformed Cookie header is simply "no token".
    }
  }

  return null;
}

/**
 * Rejects the handshake unless it carries a valid access token, and
 * attaches the resolved user to the socket for every later authorization
 * check. Errors are deliberately generic - a connection error is visible
 * to the client, and there is nothing useful to tell an unauthenticated
 * one beyond "no".
 */
function socketAuthMiddleware(socket, next) {
  const token = extractHandshakeToken(socket.handshake);
  if (!token) return next(new Error('UNAUTHENTICATED'));

  resolveUserFromToken(token)
    .then((user) => {
      socket.data.user = user;
      socket.data.userId = user._id;
      next();
    })
    .catch(() => next(new Error('UNAUTHENTICATED')));
}

module.exports = { socketAuthMiddleware, extractHandshakeToken };

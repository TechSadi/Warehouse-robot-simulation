const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { ApiError } = require('./errorHandler');
const { ACCESS_COOKIE, verifyAccessToken } = require('../utils/tokens');

/**
 * Extracts the access token. The httpOnly cookie is the primary transport
 * (see utils/tokens.js); the Authorization header is accepted as well so
 * non-browser clients - curl, the test suite, a future CLI - do not need a
 * cookie jar. Both paths verify identically; neither is trusted more.
 */
function extractToken(req) {
  const fromCookie = req.cookies?.[ACCESS_COOKIE];
  if (fromCookie) return fromCookie;

  const header = req.get('authorization');
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();

  return null;
}

/** Verifies a token and loads the owning user. Shared by the HTTP
 * middleware below and the Socket.IO handshake (sockets/socketAuth.js), so
 * both transports enforce exactly the same rules. */
async function resolveUserFromToken(token) {
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new ApiError(401, 'Session expired', { code: 'TOKEN_EXPIRED' });
    throw new ApiError(401, 'Not authenticated');
  }

  const user = await User.findById(payload.sub);
  if (!user) throw new ApiError(401, 'Not authenticated');

  // A token minted before a "log out everywhere" / password change is
  // stale even though its signature and expiry still check out.
  if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
    throw new ApiError(401, 'Session expired', { code: 'TOKEN_REVOKED' });
  }

  return user;
}

/** Rejects the request unless it carries a valid access token. */
const requireAuth = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) throw new ApiError(401, 'Not authenticated');

  const user = await resolveUserFromToken(token);
  req.user = user;
  req.userId = user._id;
  next();
});

/** Attaches req.user when a valid token is present, but never rejects.
 * Used by endpoints that are legitimately public (health). */
const optionalAuth = asyncHandler(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const user = await resolveUserFromToken(token);
    req.user = user;
    req.userId = user._id;
  } catch {
    // An invalid token on an optional route is simply "not signed in".
  }
  next();
});

/** Role gate. Authorization in this app is ownership-based (see
 * middleware/authorize.js); this exists only for genuinely
 * administrative surfaces and is deliberately not used to substitute for
 * an ownership check. */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new ApiError(401, 'Not authenticated'));
    if (!roles.includes(req.user.role)) return next(new ApiError(403, 'Insufficient permissions'));
    next();
  };
}

module.exports = { requireAuth, optionalAuth, requireRole, resolveUserFromToken, extractToken };

const authService = require('../services/authService');
const asyncHandler = require('../utils/asyncHandler');
const { pick } = require('../middleware/dto');
const { ApiError } = require('../middleware/errorHandler');
const { REFRESH_COOKIE, setAuthCookies, clearAuthCookies } = require('../utils/tokens');
const env = require('../config/env');

/**
 * Explicit allow-lists. `req.body` is never handed to the User model:
 * without these, `POST /api/auth/register` with `{"role":"admin"}` or
 * `{"tokenVersion":99}` would write straight through to the document.
 */
const REGISTER_FIELDS = ['email', 'password', 'name'];
const LOGIN_FIELDS = ['email', 'password'];

/** Sends the cookie set plus the body every auth response shares. The
 * CSRF token is echoed in the body as well as the cookie so a client that
 * cannot read cookies (a native app, a test) can still send the header. */
function respondWithSession(res, status, user, session) {
  setAuthCookies(res, session);
  res.status(status).json({
    success: true,
    data: {
      user: user.toPublicJSON(),
      csrfToken: session.csrfToken,
      // So the client can schedule a silent refresh before the access
      // token lapses, rather than discovering it via a failed request.
      expiresIn: env.auth.accessTtlSeconds,
    },
  });
}

const register = asyncHandler(async (req, res) => {
  const payload = pick(req.body, REGISTER_FIELDS);
  const { user, session } = await authService.register(payload, req);
  respondWithSession(res, 201, user, session);
});

const login = asyncHandler(async (req, res) => {
  const payload = pick(req.body, LOGIN_FIELDS);
  const { user, session } = await authService.login(payload, req);
  respondWithSession(res, 200, user, session);
});

const refresh = asyncHandler(async (req, res) => {
  const presented = req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken;
  const { user, session } = await authService.refresh(presented, req);
  respondWithSession(res, 200, user, session);
});

const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken);
  clearAuthCookies(res);
  // 200 regardless of whether a session was actually found: logout must be
  // idempotent, and telling a caller whether a token was valid is another
  // small oracle.
  res.json({ success: true, data: { message: 'Signed out' } });
});

const logoutAll = asyncHandler(async (req, res) => {
  await authService.logoutEverywhere(req.userId);
  clearAuthCookies(res);
  res.json({ success: true, data: { message: 'Signed out of all sessions' } });
});

const me = asyncHandler(async (req, res) => {
  if (!req.user) throw new ApiError(401, 'Not authenticated');
  res.json({ success: true, data: { user: req.user.toPublicJSON() } });
});

module.exports = { register, login, refresh, logout, logoutAll, me };

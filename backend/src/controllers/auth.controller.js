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
// `mfaCode`/`recoveryCode` are part of the credential, not extra state:
// they are checked against the account and never written to it.
const LOGIN_FIELDS = ['email', 'password', 'mfaCode', 'recoveryCode'];

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

/**
 * Password reset, in two halves.
 *
 * The request half answers 202 with the same body whether or not the
 * address has an account, and whether or not the mail transport actually
 * delivered anything. Reporting either would make this a cleaner
 * account-existence oracle than the login form, which goes to real trouble
 * not to be one; and a caller has no legitimate use for the difference,
 * because the next step is "check your email" regardless.
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.requestPasswordReset({ email: req.body.email }, req);
  res.status(202).json({
    success: true,
    data: {
      message: 'If that address has an account, a reset link is on its way.',
      // Returned only under test, so the suite can drive the whole flow
      // without an inbox. `env.isTest` is process-level, not
      // client-influenced - see services/authService.js.
      ...(result.token ? { token: result.token } : {}),
    },
  });
});

/** Completing a reset signs the user in on the spot: they have just
 * proven control of the mailbox and set a password, and bouncing them to a
 * login form to type it again immediately adds nothing. */
const resetPassword = asyncHandler(async (req, res) => {
  const { user } = await authService.resetPassword(
    { token: req.body.token, password: req.body.password },
    req
  );
  const session = await authService.issueSession(user, req);
  respondWithSession(res, 200, user, session);
});

/** Changing a password revokes every other session, so the caller needs a
 * fresh pair or their own next request would fail. */
const changePassword = asyncHandler(async (req, res) => {
  const { user } = await authService.changePassword(
    req.userId,
    { currentPassword: req.body.currentPassword, newPassword: req.body.newPassword },
    req
  );
  const session = await authService.issueSession(user, req);
  respondWithSession(res, 200, user, session);
});

const requestEmailVerification = asyncHandler(async (req, res) => {
  const result = await authService.requestEmailVerification(req.user, req);
  res.status(202).json({
    success: true,
    data: {
      message: result.alreadyVerified
        ? 'That address is already confirmed.'
        : 'A confirmation link is on its way.',
      ...(result.token ? { token: result.token } : {}),
    },
  });
});

/** Unauthenticated on purpose: the link is followed from an email client,
 * which may well not be the browser holding the session. The token is the
 * credential. */
const verifyEmail = asyncHandler(async (req, res) => {
  await authService.verifyEmail({ token: req.body.token }, req);
  res.json({ success: true, data: { message: 'Email address confirmed.' } });
});

const beginMfaEnrolment = asyncHandler(async (req, res) => {
  const data = await authService.beginMfaEnrolment(req.userId);
  // The secret is returned once, to be shown as a QR code and typed into
  // an authenticator app. It is not yet load-bearing: nothing is enforced
  // until /mfa/enable proves the user can read codes from it.
  res.json({ success: true, data });
});

const enableMfa = asyncHandler(async (req, res) => {
  const { recoveryCodes } = await authService.enableMfa(req.userId, { code: req.body.code }, req);
  res.json({
    success: true,
    data: {
      message: 'Multi-factor authentication is on.',
      // The only time these are ever readable - they are stored hashed.
      recoveryCodes,
    },
  });
});

const disableMfa = asyncHandler(async (req, res) => {
  const result = await authService.disableMfa(
    req.userId,
    { password: req.body.password, code: req.body.code, recoveryCode: req.body.recoveryCode },
    req
  );
  res.json({
    success: true,
    data: { message: result.disabled ? 'Multi-factor authentication is off.' : 'It was already off.' },
  });
});

module.exports = {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  me,
  forgotPassword,
  resetPassword,
  changePassword,
  requestEmailVerification,
  verifyEmail,
  beginMfaEnrolment,
  enableMfa,
  disableMfa,
};

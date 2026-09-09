const { ApiError } = require('./errorHandler');
const { CSRF_COOKIE, CSRF_HEADER, ACCESS_COOKIE, REFRESH_COOKIE, safeEqual } = require('../utils/tokens');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Endpoints whose authority is something other than the session cookie.
 *
 * Each of these carries its own credential - a password, or a token from
 * an email - and none of them acts on behalf of the cookie the browser
 * happens to be holding. A stale cookie is not a credential being ridden
 * here, so its mere presence must not decide whether the request is
 * allowed.
 *
 * Gating them on cookie presence, as this used to, wedged the application
 * shut. Auth cookies outlive their sessions: the access cookie lasts 15
 * minutes and the refresh cookie 30 days, and a session can be revoked,
 * rotated out, or simply left behind by a deployment while both cookies
 * sit in the jar. Anyone in that state was refused by every endpoint that
 * could have got them out of it - register, login, forgot-password,
 * reset-password and verify-email all answered 403 before they even
 * validated the body - and the only fix was to clear cookies by hand in
 * developer tools. Cross-origin they could not even be cleared by the
 * page, because the cookies belong to the API's origin, not the app's.
 *
 * What stays protected is everything whose authority *is* the ambient
 * cookie: /auth/refresh (which mints a whole new session from the refresh
 * cookie - the single most valuable request here to forge), /auth/logout,
 * and every authenticated write in the rest of the API. Signing in again
 * overwrites the stale cookies, so the wedge now clears itself.
 */
const CREDENTIAL_BEARING_PATHS = new Set([
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/password/forgot',
  '/api/auth/password/reset',
  '/api/auth/email/verify',
]);

/** Matched against the full path rather than `req.path`, which is relative
 * to wherever this middleware was mounted - it runs both app-wide under
 * /api and per-route inside the auth router, where the same endpoint has
 * two different `req.path` values. */
function isCredentialBearing(req) {
  const [pathname] = req.originalUrl.split('?');
  return CREDENTIAL_BEARING_PATHS.has(pathname.replace(/\/+$/, '') || '/');
}

/**
 * Double-submit CSRF protection.
 *
 * Because the session lives in a cookie, the browser attaches it to
 * cross-site requests automatically - so a state-changing request must
 * additionally prove the caller could *read* our cookies, which the
 * same-origin policy denies to an attacker's page. The client echoes the
 * non-httpOnly CSRF cookie back in a header; a forged request can send the
 * cookie but not the header.
 *
 * Only cookie-authenticated requests need this. A caller presenting an
 * `Authorization: Bearer` token is not riding an ambient credential -
 * there is nothing for a third-party site to abuse - so bearer clients
 * (curl, tests, a future CLI) are exempt. So are the endpoints that carry
 * their own credential rather than acting on the cookie's authority; see
 * CREDENTIAL_BEARING_PATHS above for why that exemption has to exist.
 */
function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (isCredentialBearing(req)) return next();

  // Either cookie counts. Keying only on the access cookie would leave a
  // gap exactly where it hurts most: once a short-lived access token
  // expires, its cookie is gone, but the refresh cookie remains - and
  // POST /api/auth/refresh, the one request that mints a whole new
  // session, would have been the request left unprotected.
  const usesCookieAuth = Boolean(req.cookies?.[ACCESS_COOKIE] || req.cookies?.[REFRESH_COOKIE]);
  if (!usesCookieAuth) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get(CSRF_HEADER);

  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
    return next(new ApiError(403, 'Invalid or missing CSRF token', { code: 'CSRF_FAILED' }));
  }

  next();
}

module.exports = csrfProtection;

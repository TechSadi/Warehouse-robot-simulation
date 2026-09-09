const { ApiError } = require('./errorHandler');
const { CSRF_COOKIE, CSRF_HEADER, ACCESS_COOKIE, REFRESH_COOKIE, safeEqual } = require('../utils/tokens');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
 * (curl, tests, a future CLI) are exempt.
 */
function csrfProtection(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

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

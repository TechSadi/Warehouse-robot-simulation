const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');

const ACCESS_COOKIE = 'wrs_access';
const REFRESH_COOKIE = 'wrs_refresh';
// Readable by JavaScript on purpose - this is the client half of the
// double-submit CSRF pair. It is not a credential on its own: it only
// proves the caller could read a cookie from our origin, which a
// cross-site attacker cannot do.
const CSRF_COOKIE = 'wrs_csrf';
const CSRF_HEADER = 'x-csrf-token';

// Scoping the refresh cookie to the auth routes means it is not attached
// to ordinary API calls at all, so the long-lived credential is simply
// absent from the vast majority of requests that could leak it.
const REFRESH_COOKIE_PATH = '/api/auth';

function signAccessToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), role: user.role, tv: user.tokenVersion ?? 0 },
    env.auth.accessSecret,
    {
      expiresIn: env.auth.accessTtlSeconds,
      issuer: env.auth.issuer,
      audience: env.auth.audience,
      // A unique id per token: two logins never produce a byte-identical
      // token, so a session identifier can never be "pre-seeded" and then
      // reused after authentication (session fixation).
      jwtid: crypto.randomUUID(),
    }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.auth.accessSecret, {
    issuer: env.auth.issuer,
    audience: env.auth.audience,
    // Pin the algorithm: without this, a token declaring `alg: none` (or a
    // key-confusion attack against an asymmetric key) would be accepted.
    algorithms: ['HS256'],
  });
}

/** Refresh tokens are opaque random strings, not JWTs - their authority
 * comes entirely from matching a stored (hashed) server-side record, so
 * there is no claim for an attacker to forge. */
function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function baseCookieOptions() {
  return {
    // The browser must never expose the session credentials to page
    // scripts - this is what limits an XSS to the lifetime of the page
    // rather than handing over a copyable long-lived token.
    httpOnly: true,
    secure: env.cookies.secure,
    sameSite: env.cookies.sameSite,
    ...(env.cookies.domain ? { domain: env.cookies.domain } : {}),
  };
}

function setAuthCookies(res, { accessToken, refreshToken, csrfToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...baseCookieOptions(),
    path: '/',
    maxAge: env.auth.accessTtlSeconds * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookieOptions(),
    path: REFRESH_COOKIE_PATH,
    maxAge: env.auth.refreshTtlSeconds * 1000,
  });
  res.cookie(CSRF_COOKIE, csrfToken, {
    ...baseCookieOptions(),
    httpOnly: false, // the client has to read this one to echo it back
    path: '/',
    maxAge: env.auth.refreshTtlSeconds * 1000,
  });
}

/**
 * Returns the CSRF token for the current request, setting the cookie first
 * if this browser somehow does not have one.
 *
 * This exists for the cross-origin deployment. The double-submit pair
 * works by having the client read the CSRF cookie and echo it in a header,
 * but a cookie set by the API's origin is host-only - a page served from
 * the frontend's origin (Vercel, while the API is on Render) cannot see it
 * through `document.cookie` at all. Handing the value back in the body of
 * an authenticated, CORS-restricted GET is what lets that client hold up
 * its half of the pair; only the allow-listed frontend origin can read the
 * response, so this reveals nothing to a cross-site attacker that the
 * cookie did not already.
 */
function ensureCsrfCookie(req, res) {
  const existing = req.cookies?.[CSRF_COOKIE];
  if (existing) return existing;

  const csrfToken = generateCsrfToken();
  res.cookie(CSRF_COOKIE, csrfToken, {
    ...baseCookieOptions(),
    httpOnly: false,
    path: '/',
    maxAge: env.auth.refreshTtlSeconds * 1000,
  });
  return csrfToken;
}

function clearAuthCookies(res) {
  const base = baseCookieOptions();
  // Attributes must match the ones the cookie was set with, or the browser
  // treats it as a different cookie and quietly leaves the original in place.
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
  res.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false, path: '/' });
}

/** Length-safe constant-time string comparison for CSRF tokens.
 * `timingSafeEqual` throws on length mismatch, so compare digests of the
 * inputs instead of the raw values - equal length by construction. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  CSRF_COOKIE,
  CSRF_HEADER,
  REFRESH_COOKIE_PATH,
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  generateCsrfToken,
  setAuthCookies,
  ensureCsrfCookie,
  clearAuthCookies,
  safeEqual,
};

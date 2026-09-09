const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const env = require('../config/env');
const { MongoRateLimitStore } = require('./rateLimitStore');

/**
 * Tiered rate limiting.
 *
 * A single global limit would either be loose enough to be useless against
 * credential stuffing, or tight enough to break the simulation - a running
 * warehouse legitimately issues far more requests per minute than a human
 * clicking around ever would. So limits are set per cost class instead:
 * strict on authentication, generous on ordinary reads, and specifically
 * bounded on the endpoints that do real CPU or database work (A* search,
 * trace mode, order generation, dispatch, manual ticks).
 */

// A raw IPv6 address is a terrible rate-limit key: a residential client is
// routinely handed a whole /64 and can pick a fresh address per request,
// resetting its budget every time. `ipKeyGenerator` collapses IPv6 to its
// /64 prefix (and leaves IPv4 alone), so the key identifies the subscriber
// rather than one of their 2^64 addresses.
function ipKey(req) {
  return ipKeyGenerator(req.ip);
}

// Keying by user id when signed in means one abusive account cannot exhaust
// the budget of everyone else behind the same NAT/corporate egress IP, and
// conversely that rotating IPs does not reset an authenticated attacker's
// budget. Falls back to IP for unauthenticated routes (login, register).
function keyGenerator(req) {
  return req.userId ? `user:${req.userId}` : `ip:${ipKey(req)}`;
}

/**
 * Where the counters live.
 *
 * The default memory store is per process: limits are not shared across
 * instances and reset on restart, so a second instance doubles every
 * budget and a redeploy hands out fresh ones. `RATE_LIMIT_STORE=mongo`
 * (the production default) puts them in the database this app already has
 * - see middleware/rateLimitStore.js for why Mongo rather than Redis.
 *
 * Each limiter gets its own prefix so their key spaces cannot collide: two
 * limiters that both key by IP would otherwise share one counter and
 * silently enforce the tighter of the two on both.
 */
function storeFor(prefix) {
  if (env.rateLimits.store !== 'mongo') return undefined; // memory store
  return new MongoRateLimitStore({ prefix });
}

const shared = {
  standardHeaders: true, // RateLimit-* headers, so clients can back off politely
  legacyHeaders: false,
  // Rate limits exist to stop abuse, not to make the test suite flaky.
  skip: () => env.isTest,
  message: { success: false, error: { message: 'Too many requests. Please slow down.' } },
};

/** Sign-in / registration / refresh. Deliberately tight: this is the
 * surface where guessing is worth something. */
const authLimiter = rateLimit({
  ...shared,
  store: storeFor('auth'),
  windowMs: 15 * 60 * 1000,
  max: 10,
  // Failed attempts are what we are budgeting; a user who signs in
  // correctly should not be locked out by their own successful logins.
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `auth:${ipKey(req)}`,
  message: {
    success: false,
    error: { message: 'Too many authentication attempts. Please try again later.' },
  },
});

/** Account creation, keyed by IP - slows bulk account farming and bounds
 * how fast the registration endpoint can be probed for existing emails.
 *
 * The ceiling is overridable purely so a browser-driven end-to-end suite
 * can run against a disposable dev or staging backend: those tests register
 * real accounts through the real form, and five per hour per IP is -
 * correctly - fewer than such a suite needs. Same reasoning and the same
 * pattern as TICK_INTERVAL_MS. The default is the production value and
 * production must keep it: raising this on a real deployment turns
 * registration back into a usable oracle for which emails have accounts,
 * which is the thing this limit exists to prevent. env.js refuses the
 * override in production for exactly that reason. */
const registerLimiter = rateLimit({
  ...shared,
  store: storeFor('register'),
  windowMs: 60 * 60 * 1000,
  max: env.rateLimits.registrationsPerHour,
  keyGenerator: (req) => `register:${ipKey(req)}`,
});

/** Baseline for ordinary authenticated API traffic. Sized so a live
 * dashboard (polling health, listing robots/orders/logs) never comes close. */
const apiLimiter = rateLimit({
  ...shared,
  store: storeFor('api'),
  windowMs: 60 * 1000,
  max: 600,
  keyGenerator,
});

/** A* pathfinding: an unbounded search over an 80x80 grid per request. */
const pathfindingLimiter = rateLimit({
  ...shared,
  store: storeFor('path'),
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator,
  message: { success: false, error: { message: 'Too many pathfinding requests. Please slow down.' } },
});

/** Trace mode records every step of the search and serialises it - orders
 * of magnitude more expensive than a plain path request, in both CPU and
 * response size, so it gets its own much tighter budget. Applied on top of
 * pathfindingLimiter, not instead of it. */
const traceLimiter = rateLimit({
  ...shared,
  store: storeFor('trace'),
  windowMs: 60 * 1000,
  max: 15,
  keyGenerator,
  // Only trace requests consume this budget; a plain path request should
  // not spend the expensive allowance.
  skip: (req) => env.isTest || req.body?.trace !== true,
  message: {
    success: false,
    error: { message: 'Too many A* trace requests. Please slow down.' },
  },
});

/** Order generation writes N documents per call. */
const orderGenerationLimiter = rateLimit({
  ...shared,
  store: storeFor('orders'),
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator,
});

/** Dispatch runs the scheduling strategy over every pending order and
 * every idle robot, then bulk-writes both sides. */
const dispatchLimiter = rateLimit({
  ...shared,
  store: storeFor('dispatch'),
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator,
});

/** Manual ticks. The normal path is the server-owned Socket.IO loop, which
 * is bounded by its own interval; this endpoint is for scripting a single
 * step, so it needs enough headroom to drive a simulation by hand without
 * being an unmetered way to run the engine flat out. */
const tickLimiter = rateLimit({
  ...shared,
  store: storeFor('tick'),
  windowMs: 60 * 1000,
  max: 240,
  keyGenerator,
});

/** Writes that create persistent documents (warehouses, robots, orders,
 * obstacles, logs, statistics). */
const writeLimiter = rateLimit({
  ...shared,
  store: storeFor('write'),
  windowMs: 60 * 1000,
  max: 200,
  keyGenerator,
});

/**
 * Password reset, email verification and MFA changes.
 *
 * Tighter than `authLimiter` and on a longer window, because these
 * endpoints are worth more to an attacker than a login attempt is. A reset
 * request sends mail to an address the caller named, so an unlimited one
 * is both an account-existence oracle and a way to use this service to
 * spam a third party; and each one supersedes the previous token, so a
 * flood is also a denial of service against a user genuinely trying to
 * recover their account. Keyed by IP, since by definition the caller may
 * not be signed in.
 */
const accountRecoveryLimiter = rateLimit({
  ...shared,
  store: storeFor('recovery'),
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => `recovery:${ipKey(req)}`,
  message: {
    success: false,
    error: { message: 'Too many account recovery requests. Please try again later.' },
  },
});

module.exports = {
  authLimiter,
  registerLimiter,
  accountRecoveryLimiter,
  apiLimiter,
  pathfindingLimiter,
  traceLimiter,
  orderGenerationLimiter,
  dispatchLimiter,
  tickLimiter,
  writeLimiter,
};

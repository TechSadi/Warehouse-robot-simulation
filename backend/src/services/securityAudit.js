const SecurityEvent = require('../models/SecurityEvent');
const env = require('../config/env');

/**
 * Writes the security audit trail (models/SecurityEvent.js).
 *
 * Two rules govern every call here, and they are why this is a module
 * rather than an inline `SecurityEvent.create` at each site:
 *
 * 1. **Recording must never change the outcome.** A failure to write an
 *    audit row cannot be allowed to turn a successful sign-in into a 500,
 *    or - worse - to make a *failed* sign-in behave observably differently
 *    from a successful one. Every write is fire-and-forget and swallows
 *    its own errors.
 *
 * 2. **Never record the thing being protected.** No passwords, no tokens,
 *    no TOTP codes, no reset links. Callers pass structured context, not
 *    request bodies.
 */

/**
 * Truncates an address to a network rather than a host: the last IPv4
 * octet and everything below an IPv6 /48 are dropped.
 *
 * The trail exists to spot patterns - one source sweeping many accounts,
 * one account probed from many sources - and a network identifies a source
 * for that purpose just as well as a host does. Keeping the full address
 * would make this a log of where individual people were when they signed
 * in, which is a materially different (and more sensitive) dataset than
 * the one this is for.
 */
function truncateIp(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return '';
  if (raw.includes(':')) {
    const groups = raw.split(':').filter(Boolean);
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  const octets = raw.split('.');
  if (octets.length !== 4) return '';
  return `${octets.slice(0, 3).join('.')}.0/24`;
}

/** Pulls the non-sensitive request context every event shares. Accepts a
 * plain object as well as an Express request, so socket handlers and the
 * test suite can use it too. */
function contextFrom(req) {
  return {
    ip: truncateIp(req?.ip),
    userAgent: String(req?.get?.('user-agent') || req?.userAgent || '').slice(0, 300),
  };
}

/**
 * Records one event. Never throws, never awaits into the caller's critical
 * path unless the caller chooses to await it (tests do).
 *
 * @param {string} type one of SecurityEvent.TYPES
 * @param {{req?: any, userId?: any, email?: string, detail?: any, outcome?: 'success'|'failure'}} options
 */
function record(type, { req, userId = null, email = null, detail, outcome } = {}) {
  const promise = SecurityEvent.create({
    type,
    userId,
    email: email ? String(email).toLowerCase() : null,
    ...contextFrom(req),
    detail,
    outcome: outcome || (type.endsWith('_failed') || type.endsWith('_denied') ? 'failure' : 'success'),
  }).catch((err) => {
    // Logged rather than raised: an unwritable audit row is an operational
    // problem, not a reason to fail the request it describes.
    if (!env.isTest) console.error(`[audit] could not record ${type}:`, err.message);
    return null;
  });
  return promise;
}

module.exports = { record, truncateIp, contextFrom };

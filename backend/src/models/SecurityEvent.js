const mongoose = require('mongoose');

/**
 * The security audit trail.
 *
 * Failed logins, lockouts, refresh-token reuse and authorization denials
 * all had defences built for them, and none of them left a record - so the
 * only way to find out an account was under attack was to be watching the
 * process log at the time. That was the documented "no audit logging of
 * security events" gap, and it is the difference between a system that
 * resists an attack and one that can also tell you it happened.
 *
 * Deliberately a separate collection from `Log`, not a `source` value on
 * it. `Log` is simulation history: owned by a warehouse, readable by that
 * warehouse's owner, and deleted when it is. These records are neither -
 * they are about accounts, they are only ever written by the server, and
 * they must outlive the resources they mention. Putting them in `Log`
 * would mean either exposing them through an ownership check that does not
 * apply to them, or bolting an exception onto every read path that does.
 *
 * What is *not* recorded is as deliberate as what is: no passwords, no
 * tokens, no code values, and IP addresses only in truncated form (see
 * services/securityAudit.js). An audit trail that leaks the credentials it
 * is auditing is a liability, not a control.
 */
const TYPES = [
  'login_succeeded',
  'login_failed',
  'account_locked',
  'logout',
  'logout_all',
  'registered',
  'password_reset_requested',
  'password_reset_completed',
  'password_changed',
  'email_verification_requested',
  'email_verified',
  'mfa_enabled',
  'mfa_disabled',
  'mfa_challenge_failed',
  'mfa_recovery_code_used',
  'refresh_reuse_detected',
  'authorization_denied',
  'admin_action',
];

const securityEventSchema = new mongoose.Schema(
  {
    type: { type: String, enum: TYPES, required: true },
    // Null for events about an address that turned out not to have an
    // account - which is itself worth recording, and is why this is not
    // required.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /** Normalised, so a sweep across many addresses is visible as one
     * pattern rather than as unrelated rows. Stored even when no account
     * matched; that is the signal. */
    email: { type: String, lowercase: true, trim: true, maxlength: 254, default: null },
    /** Truncated - enough to correlate, not enough to be a location
     * record. See services/securityAudit.js. */
    ip: { type: String, maxlength: 64, default: '' },
    userAgent: { type: String, maxlength: 300, default: '' },
    /** Free-form, server-authored context: which route was denied, which
     * resource, which admin action. Never client-supplied. */
    detail: { type: mongoose.Schema.Types.Mixed, default: undefined },
    outcome: { type: String, enum: ['success', 'failure'], default: 'failure' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

securityEventSchema.index({ createdAt: -1 });
securityEventSchema.index({ type: 1, createdAt: -1 });
securityEventSchema.index({ userId: 1, createdAt: -1 });
securityEventSchema.index({ email: 1, createdAt: -1 });

module.exports = mongoose.model('SecurityEvent', securityEventSchema);
module.exports.TYPES = TYPES;

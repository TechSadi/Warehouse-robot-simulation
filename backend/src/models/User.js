const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const env = require('../config/env');

const ROLES = ['user', 'admin'];

// Deliberately permissive but bounded - the point is to reject obviously
// malformed input and unbounded strings, not to police which addresses are
// "real" (that's what a verification email would be for).
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      match: [EMAIL_PATTERN, 'Email must be a valid address'],
    },
    // Never named `password`: the field holding a bcrypt digest should be
    // impossible to confuse with one holding a plaintext secret, in code
    // review or in a stack trace.
    passwordHash: {
      type: String,
      required: true,
      // `select: false` means no query returns the hash unless it asks for
      // it explicitly - so an accidental `res.json(user)` anywhere in the
      // app cannot leak it.
      select: false,
    },
    name: { type: String, trim: true, maxlength: 80, default: '' },
    role: { type: String, enum: ROLES, default: 'user' },

    // --- Login throttling state (brute force / credential stuffing) ----
    /**
     * Failed attempts, counted *per source network* rather than per
     * account.
     *
     * A single account-wide counter made lockout a denial-of-service
     * lever: anyone who knew a victim's email could keep the account
     * locked with a stream of wrong passwords, and the victim could not
     * sign in from anywhere. Bucketing by source keeps the defence where
     * the attack is - a source that guesses wrong repeatedly is locked out
     * of this account, and the real user, coming from somewhere else, is
     * unaffected.
     *
     * The trade this makes is explicit: an attacker with many source
     * addresses gets more guesses against one account than before. That is
     * bounded by the per-IP rate limiter (middleware/rateLimit.js), which
     * is the control actually suited to a distributed attack, and by
     * `globalFailedLogins` below, which is what surfaces one.
     *
     * Bounded in length so the array cannot be grown without limit by an
     * attacker rotating addresses - see recordFailedLogin.
     */
    loginFailures: {
      type: [
        new mongoose.Schema(
          {
            source: { type: String, required: true, maxlength: 64 },
            attempts: { type: Number, default: 0 },
            lockUntil: { type: Date, default: null },
            lastAttemptAt: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
      default: [],
      select: false,
    },
    /** Every failed attempt against this account, from anywhere. Not used
     * to block - it is the number that says "this account is being
     * attacked", which is worth recording precisely because per-source
     * lockout deliberately does not act on it. */
    globalFailedLogins: { type: Number, default: 0, select: false },
    lastLoginAt: { type: Date, default: null },

    // --- Email verification --------------------------------------------
    /** Null until the address is proven. Whether an unverified account may
     * do anything is a deployment choice (REQUIRE_EMAIL_VERIFICATION), not
     * a schema one - see middleware/auth.js. */
    emailVerifiedAt: { type: Date, default: null },

    // --- Multi-factor authentication ------------------------------------
    /**
     * The TOTP shared secret. `select: false` for the same reason as the
     * password hash: it is a credential, and an accidental `res.json(user)`
     * anywhere would hand over the second factor.
     *
     * Present but with `mfaEnabledAt` null means enrolment was started and
     * never confirmed - the secret is generated when the user asks for a
     * QR code, and only becomes load-bearing once they prove they can read
     * codes from it.
     */
    mfaSecret: { type: String, default: null, select: false },
    mfaEnabledAt: { type: Date, default: null },
    /** bcrypt digests of the one-time recovery codes, never the codes.
     * Consumed by removing the matching entry. */
    mfaRecoveryCodes: { type: [String], default: [], select: false },
    /** The last TOTP step accepted for this user. A code is valid for a
     * whole 30-second step and for a window either side of it, so without
     * this the same six digits - shoulder-surfed, or captured from a
     * phished form - could be replayed within that window. */
    mfaLastUsedStep: { type: Number, default: 0, select: false },

    // Bumping this invalidates every access token already issued to this
    // user without needing a server-side access-token blacklist - it's
    // baked into the JWT and compared on every authenticated request.
    // "Log out everywhere" and post-password-change invalidation both use
    // it, and it is what closes session fixation: a session identifier
    // that survived a privilege change would otherwise still be valid.
    tokenVersion: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.passwordHash;
        delete ret.loginFailures;
        delete ret.globalFailedLogins;
        delete ret.mfaSecret;
        delete ret.mfaRecoveryCodes;
        delete ret.mfaLastUsedStep;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// The unique index comes from `unique: true` on the field itself; the
// model lowercases on write, so `Bob@example.com` and `bob@example.com`
// cannot become two accounts.

/** True while *this source* is locked out of this account. Lockout is per
 * source by design - see the `loginFailures` field comment. */
userSchema.methods.isLockedFor = function isLockedFor(source) {
  const bucket = (this.loginFailures || []).find((b) => b.source === source);
  return Boolean(bucket?.lockUntil && bucket.lockUntil.getTime() > Date.now());
};

/** Seconds until this source may try again, or 0. */
userSchema.methods.lockSecondsFor = function lockSecondsFor(source) {
  const bucket = (this.loginFailures || []).find((b) => b.source === source);
  if (!bucket?.lockUntil) return 0;
  return Math.max(0, Math.ceil((bucket.lockUntil.getTime() - Date.now()) / 1000));
};

/** True once MFA enrolment has been confirmed. A generated-but-unconfirmed
 * secret does not count - see the `mfaSecret` field comment. */
userSchema.virtual('mfaEnabled').get(function mfaEnabled() {
  return Boolean(this.mfaEnabledAt);
});

/** Hashes a plaintext password. bcrypt (not a bare SHA) so each hash is
 * salted and deliberately slow to brute force offline. */
userSchema.statics.hashPassword = function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, env.auth.bcryptRounds);
};

/** Constant-time comparison via bcrypt - never `===` on a digest. */
userSchema.methods.verifyPassword = function verifyPassword(plaintext) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plaintext, this.passwordHash);
};

/** The public shape of a user - what /api/auth/me and the auth responses
 * return. Anything not listed here never reaches a client. */
userSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    email: this.email,
    name: this.name,
    role: this.role,
    createdAt: this.createdAt,
    lastLoginAt: this.lastLoginAt,
    // Both are facts about the caller's own account that the caller needs
    // in order to render its own settings - not disclosure about anyone
    // else, and never reachable for another user.
    emailVerified: Boolean(this.emailVerifiedAt),
    mfaEnabled: Boolean(this.mfaEnabledAt),
  };
};

module.exports = mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;
module.exports.EMAIL_PATTERN = EMAIL_PATTERN;

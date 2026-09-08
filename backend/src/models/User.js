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
    failedLoginAttempts: { type: Number, default: 0, select: false },
    lockUntil: { type: Date, default: null, select: false },
    lastLoginAt: { type: Date, default: null },

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
        delete ret.failedLoginAttempts;
        delete ret.lockUntil;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// The unique index comes from `unique: true` on the field itself; the
// model lowercases on write, so `Bob@example.com` and `bob@example.com`
// cannot become two accounts.

userSchema.virtual('isLocked').get(function isLocked() {
  return Boolean(this.lockUntil && this.lockUntil.getTime() > Date.now());
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
  };
};

module.exports = mongoose.model('User', userSchema);
module.exports.ROLES = ROLES;
module.exports.EMAIL_PATTERN = EMAIL_PATTERN;

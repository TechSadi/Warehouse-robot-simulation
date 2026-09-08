const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Server-side record of every issued refresh token, so refresh sessions
 * can actually be revoked - a plain stateless JWT refresh token cannot be
 * (it stays valid for its full lifetime no matter what).
 *
 * Only a SHA-256 digest of the token is stored: a dump of this collection
 * is useless to an attacker, exactly as with the password hash. SHA-256
 * rather than bcrypt is the right primitive here because the token is
 * already 256 bits of CSPRNG output - there is no low-entropy guess space
 * for a slow hash to defend, and every authenticated refresh would
 * otherwise pay bcrypt's cost.
 *
 * Rotation with reuse detection: each refresh consumes its token and
 * issues a new one in the same `family`. Presenting an already-rotated
 * token means either a replay or a stolen cookie, so the whole family is
 * revoked and the user must sign in again.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tokenHash: { type: String, required: true, unique: true },
    // Groups every token descended from one login, so reuse detection can
    // revoke the entire chain rather than just the replayed token.
    family: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: null },
    userAgent: { type: String, maxlength: 300, default: '' },
    ip: { type: String, maxlength: 64, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Mongo drops expired documents on its own, so revoked/expired sessions
// don't accumulate forever.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

refreshTokenSchema.statics.hashToken = function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
};

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);

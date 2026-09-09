const mongoose = require('mongoose');
const crypto = require('crypto');

const PURPOSES = ['password_reset', 'email_verification'];

/**
 * Single-use, expiring tokens for the two flows that have to reach a user
 * out of band: proving they control their email address, and recovering an
 * account whose password they have forgotten.
 *
 * Both were previously out of scope on the grounds that there is no email
 * infrastructure in the project. That was true of the *delivery*, not of
 * the flows - and the delivery is the replaceable part (services/mailer.js
 * takes a transport). What could not be deferred is getting the token
 * handling right, because a password reset is an authentication bypass by
 * design: whoever holds a valid token becomes the user.
 *
 * So the same rules as the refresh tokens next door, for the same reasons:
 *
 *  - Only a SHA-256 digest is stored. A dump of this collection cannot be
 *    replayed. SHA-256 rather than bcrypt because the token is already 256
 *    bits of CSPRNG output - there is no low-entropy guess space for a slow
 *    hash to protect.
 *  - Single use, enforced by an atomic consume (`usedAt` set in the same
 *    conditional update that reads it), so two racing requests cannot both
 *    redeem one token.
 *  - Short lived, and shorter for a reset than for a verification: a reset
 *    token is a live credential, a verification token is not.
 *  - Issuing a new token of a purpose invalidates the outstanding ones for
 *    that user, so a leaked older link stops working the moment the user
 *    asks for another.
 */
const verificationTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    purpose: { type: String, enum: PURPOSES, required: true },
    tokenHash: { type: String, required: true, unique: true },
    /**
     * The address the token was issued for.
     *
     * A reset token must stop working if the account's email changes
     * between issue and redemption - otherwise a token mailed to an old
     * address still opens the account after the address is corrected,
     * which is precisely the takeover a reset flow has to prevent.
     */
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    ip: { type: String, maxlength: 64, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Mongo drops them on its own once they lapse, so spent and expired tokens
// do not accumulate. Correctness does not depend on the TTL monitor's
// timing: every read also compares `expiresAt` itself.
verificationTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
verificationTokenSchema.index({ userId: 1, purpose: 1 });

verificationTokenSchema.statics.hashToken = function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
};

module.exports = mongoose.model('VerificationToken', verificationTokenSchema);
module.exports.PURPOSES = PURPOSES;

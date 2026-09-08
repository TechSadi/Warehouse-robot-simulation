const bcrypt = require('bcryptjs');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const env = require('../config/env');
const { ApiError } = require('../middleware/errorHandler');
const {
  signAccessToken,
  generateRefreshToken,
  generateCsrfToken,
} = require('../utils/tokens');

// One message for "no such account" and for "wrong password". Anything
// that distinguishes them turns the login form into an account-existence
// oracle (credential enumeration) - the same reason registration below
// does not report "email already taken" either.
const INVALID_CREDENTIALS = 'Invalid email or password';

// A precomputed hash of a value nobody can supply, compared against
// whenever the email doesn't exist. Skipping bcrypt on the unknown-account
// path would make it measurably faster than the wrong-password path, which
// is the same enumeration leak by a side channel.
const DUMMY_HASH = bcrypt.hashSync('unused-timing-equalisation-value', env.auth.bcryptRounds);

function sessionMetadata(req) {
  return {
    userAgent: String(req?.get?.('user-agent') || '').slice(0, 300),
    ip: String(req?.ip || '').slice(0, 64),
  };
}

/** Issues a fresh access token, a fresh refresh token (persisted hashed),
 * and a CSRF token. Every login and every rotation goes through here, so
 * a caller can never accidentally reuse an old session identifier. */
async function issueSession(user, req, { family } = {}) {
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.auth.refreshTtlSeconds * 1000);

  const record = await RefreshToken.create({
    userId: user._id,
    tokenHash: RefreshToken.hashToken(refreshToken),
    family: family || RefreshToken.hashToken(refreshToken),
    expiresAt,
    ...sessionMetadata(req),
  });

  return {
    accessToken: signAccessToken(user),
    refreshToken,
    csrfToken: generateCsrfToken(),
    family: record.family,
  };
}

async function register({ email, password, name }, req) {
  const existing = await User.findOne({ email: email.toLowerCase() }).select('_id');
  if (existing) {
    // 409 with a generic message: it is unavoidable that registration
    // reveals *something* about an existing address (two accounts cannot
    // share one email), so keep the wording neutral and let the rate
    // limiter on this route bound how fast a list can be probed.
    throw new ApiError(409, 'Unable to register with those details');
  }

  const user = await User.create({
    email: email.toLowerCase(),
    passwordHash: await User.hashPassword(password),
    name: name || '',
    role: 'user', // never client-controlled - see the register DTO
  });

  const session = await issueSession(user, req);
  return { user, session };
}

async function login({ email, password }, req) {
  const user = await User.findOne({ email: String(email).toLowerCase() }).select(
    '+passwordHash +failedLoginAttempts +lockUntil'
  );

  if (!user) {
    await bcrypt.compare(String(password), DUMMY_HASH); // equalise timing
    throw new ApiError(401, INVALID_CREDENTIALS);
  }

  if (user.lockUntil && user.lockUntil.getTime() > Date.now()) {
    const retryAfter = Math.ceil((user.lockUntil.getTime() - Date.now()) / 1000);
    throw new ApiError(429, 'Too many failed sign-in attempts. Try again later.', { retryAfter });
  }

  const ok = await user.verifyPassword(String(password));
  if (!ok) {
    const attempts = (user.failedLoginAttempts || 0) + 1;
    const update = { failedLoginAttempts: attempts };
    if (attempts >= env.auth.maxFailedLogins) {
      // Per-account lockout complements the per-IP rate limiter: one stops
      // a single host hammering many accounts, the other stops a
      // distributed attack concentrating on one account.
      update.lockUntil = new Date(Date.now() + env.auth.lockoutSeconds * 1000);
      update.failedLoginAttempts = 0;
    }
    await User.updateOne({ _id: user._id }, { $set: update });
    throw new ApiError(401, INVALID_CREDENTIALS);
  }

  // Successful login resets the counter and, by issuing an entirely new
  // token pair, guarantees the post-authentication session identifier is
  // never one that existed before the credentials were checked.
  await User.updateOne(
    { _id: user._id },
    { $set: { failedLoginAttempts: 0, lockUntil: null, lastLoginAt: new Date() } }
  );

  const session = await issueSession(user, req);
  return { user, session };
}

/**
 * Rotates a refresh token. Consumes the presented token and issues a
 * successor in the same family. Presenting a token that was already
 * rotated or revoked is treated as theft: the whole family is revoked, so
 * both the attacker and the legitimate holder are forced to sign in again
 * rather than the attacker silently riding along.
 */
async function refresh(presentedToken, req) {
  if (!presentedToken) throw new ApiError(401, 'Not authenticated');

  const tokenHash = RefreshToken.hashToken(presentedToken);
  const record = await RefreshToken.findOne({ tokenHash });
  if (!record) throw new ApiError(401, 'Session expired. Please sign in again.');

  if (record.revokedAt || record.expiresAt.getTime() <= Date.now()) {
    await RefreshToken.updateMany(
      { family: record.family, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    throw new ApiError(401, 'Session expired. Please sign in again.');
  }

  const user = await User.findById(record.userId);
  if (!user) {
    await RefreshToken.updateMany({ family: record.family }, { $set: { revokedAt: new Date() } });
    throw new ApiError(401, 'Session expired. Please sign in again.');
  }

  const session = await issueSession(user, req, { family: record.family });
  await RefreshToken.updateOne(
    { _id: record._id },
    { $set: { revokedAt: new Date(), replacedByHash: RefreshToken.hashToken(session.refreshToken) } }
  );

  return { user, session };
}

/** Revokes the presented session only. Logging out on a phone should not
 * sign the same user out on their laptop. */
async function logout(presentedToken) {
  if (!presentedToken) return;
  await RefreshToken.updateOne(
    { tokenHash: RefreshToken.hashToken(presentedToken), revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

/** Revokes every session for a user and invalidates outstanding access
 * tokens by bumping tokenVersion. */
async function logoutEverywhere(userId) {
  await Promise.all([
    RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } }),
    User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }),
  ]);
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  logoutEverywhere,
  issueSession,
  INVALID_CREDENTIALS,
};

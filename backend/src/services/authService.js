const bcrypt = require('bcryptjs');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const VerificationToken = require('../models/VerificationToken');
const env = require('../config/env');
const { ApiError } = require('../middleware/errorHandler');
const totp = require('../utils/totp');
const mailer = require('./mailer');
const audit = require('./securityAudit');
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

/**
 * The bucket a login attempt is counted against.
 *
 * Truncated to a network for the same reason the audit trail is: the point
 * is to identify a *source*, and a residential client handed a whole IPv6
 * /64 would otherwise get a fresh lockout budget for every request simply
 * by picking a new address.
 */
function sourceOf(req) {
  return audit.truncateIp(req?.ip) || 'unknown';
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
  const normalised = String(email).toLowerCase();
  const existing = await User.findOne({ email: normalised }).select('_id');
  if (existing) {
    // 409 with a generic message: it is unavoidable that registration
    // reveals *something* about an existing address (two accounts cannot
    // share one email), so keep the wording neutral and let the rate
    // limiter on this route bound how fast a list can be probed.
    throw new ApiError(409, 'Unable to register with those details');
  }

  const user = await User.create({
    email: normalised,
    passwordHash: await User.hashPassword(password),
    name: name || '',
    role: 'user', // never client-controlled - see the register DTO
  });

  audit.record('registered', { req, userId: user._id, email: normalised, outcome: 'success' });
  // Sent on a best-effort basis and never awaited into the response: a
  // mail transport that is slow or down must not slow down or fail
  // registration, which has already succeeded by this point.
  requestEmailVerification(user, req).catch(() => {});

  const session = await issueSession(user, req);
  return { user, session };
}

/**
 * Records a failed attempt against the source that made it.
 *
 * Per source rather than per account, which is the fix for lockout being a
 * denial-of-service lever: an attacker who knows a victim's email can no
 * longer keep them out of their own account, because the attacker's
 * network is what gets locked. See the `loginFailures` field comment in
 * models/User.js for the trade this makes and what bounds it.
 */
async function recordFailedLogin(user, source) {
  const buckets = [...(user.loginFailures || [])];
  let bucket = buckets.find((b) => b.source === source);
  if (!bucket) {
    bucket = { source, attempts: 0, lockUntil: null, lastAttemptAt: new Date() };
    buckets.push(bucket);
  }

  bucket.attempts = (bucket.attempts || 0) + 1;
  bucket.lastAttemptAt = new Date();
  let locked = false;
  if (bucket.attempts >= env.auth.maxFailedLogins) {
    bucket.lockUntil = new Date(Date.now() + env.auth.lockoutSeconds * 1000);
    bucket.attempts = 0;
    locked = true;
  }

  // Bounded, oldest-first, so rotating source addresses cannot grow one
  // user document without limit. Discarding the least recently active
  // bucket is safe: it is by definition the one least likely to be an
  // attack in progress.
  const trimmed = buckets
    .sort((a, b) => new Date(b.lastAttemptAt).getTime() - new Date(a.lastAttemptAt).getTime())
    .slice(0, env.auth.maxLoginFailureBuckets);

  await User.updateOne(
    { _id: user._id },
    { $set: { loginFailures: trimmed }, $inc: { globalFailedLogins: 1 } }
  );
  return locked;
}

async function login({ email, password, mfaCode, recoveryCode }, req) {
  const normalised = String(email).toLowerCase();
  const source = sourceOf(req);
  const user = await User.findOne({ email: normalised }).select(
    '+passwordHash +loginFailures +globalFailedLogins +mfaSecret +mfaRecoveryCodes +mfaLastUsedStep'
  );

  if (!user) {
    await bcrypt.compare(String(password), DUMMY_HASH); // equalise timing
    audit.record('login_failed', { req, email: normalised, detail: { reason: 'no_such_account' } });
    throw new ApiError(401, INVALID_CREDENTIALS);
  }

  if (user.isLockedFor(source)) {
    const retryAfter = user.lockSecondsFor(source);
    throw new ApiError(429, 'Too many failed sign-in attempts. Try again later.', { retryAfter });
  }

  const ok = await user.verifyPassword(String(password));
  if (!ok) {
    const locked = await recordFailedLogin(user, source);
    audit.record('login_failed', {
      req,
      userId: user._id,
      email: normalised,
      detail: { reason: 'bad_password' },
    });
    if (locked) {
      audit.record('account_locked', { req, userId: user._id, email: normalised, detail: { source } });
    }
    throw new ApiError(401, INVALID_CREDENTIALS);
  }

  // The password checked out; the second factor is a separate gate, and a
  // failure here is *not* an "invalid email or password" - the caller has
  // already proven the password, so there is nothing left to enumerate and
  // being vague would only confuse a legitimate user.
  if (user.mfaEnabled) {
    const result = await verifySecondFactor(user, { mfaCode, recoveryCode });
    if (!result.ok) {
      audit.record('mfa_challenge_failed', { req, userId: user._id, email: normalised });
      throw new ApiError(401, result.message, { code: result.code });
    }
    if (result.usedRecoveryCode) {
      audit.record('mfa_recovery_code_used', {
        req,
        userId: user._id,
        email: normalised,
        detail: { remaining: result.remaining },
        outcome: 'success',
      });
    }
  }

  // Successful login clears this source's failure history and, by issuing
  // an entirely new token pair, guarantees the post-authentication session
  // identifier is never one that existed before the credentials were
  // checked. Other sources' buckets are left alone - they are somebody
  // else's attempts and remain worth counting.
  await User.updateOne(
    { _id: user._id },
    {
      $pull: { loginFailures: { source } },
      $set: { lastLoginAt: new Date() },
    }
  );

  audit.record('login_succeeded', { req, userId: user._id, email: normalised, outcome: 'success' });
  const session = await issueSession(user, req);
  return { user, session };
}

/**
 * Checks a TOTP code or a recovery code.
 *
 * Replay is handled here rather than in utils/totp.js: a code is valid for
 * a whole 30-second step plus a window either side, so without recording
 * the accepted step the same six digits - shoulder-surfed, or captured by
 * a phishing page and relayed - would work twice.
 */
async function verifySecondFactor(user, { mfaCode, recoveryCode }) {
  if (recoveryCode) {
    const codes = user.mfaRecoveryCodes || [];
    for (const hash of codes) {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(String(recoveryCode).trim().toUpperCase(), hash)) {
        // Consumed by removal - a recovery code is single use, and the
        // pull is atomic so two racing requests cannot both spend it.
        const result = await User.updateOne(
          { _id: user._id, mfaRecoveryCodes: hash },
          { $pull: { mfaRecoveryCodes: hash } }
        );
        if (!result?.modifiedCount) break;
        return { ok: true, usedRecoveryCode: true, remaining: codes.length - 1 };
      }
    }
    return { ok: false, message: 'That recovery code is not valid', code: 'MFA_INVALID' };
  }

  if (!mfaCode) {
    return {
      ok: false,
      message: 'A verification code from your authenticator app is required',
      code: 'MFA_REQUIRED',
    };
  }

  const { valid, step } = totp.verify(user.mfaSecret, String(mfaCode), {
    window: env.auth.totpWindow,
  });
  if (!valid) {
    return { ok: false, message: 'That verification code is not valid', code: 'MFA_INVALID' };
  }
  if (step <= (user.mfaLastUsedStep || 0)) {
    return { ok: false, message: 'That verification code has already been used', code: 'MFA_REPLAY' };
  }
  await User.updateOne({ _id: user._id }, { $set: { mfaLastUsedStep: step } });
  return { ok: true };
}

/**
 * Rotates a refresh token. Consumes the presented token and issues a
 * successor in the same family. Presenting a token that was already
 * rotated or revoked is treated as theft: the whole family is revoked, so
 * both the attacker and the legitimate holder are forced to sign in again
 * rather than the attacker silently riding along.
 *
 * **Consume first, then issue.** The order is the whole point. Revoking
 * the predecessor and issuing the successor are two writes and cannot be
 * one without a transaction (which needs a replica set this deployment
 * does not have). Issuing first left a window in which a crash produced a
 * valid successor *and* an unrevoked predecessor - and the next use of
 * that predecessor then looked exactly like token reuse, so it killed the
 * family and signed the user out for no reason. Consuming first inverts
 * the failure: a crash in the window leaves the predecessor spent and no
 * successor issued, which costs one sign-in and cannot be mistaken for an
 * attack. The consume is a single conditional update, so two concurrent
 * refreshes with the same token race on one document and exactly one wins.
 */
async function refresh(presentedToken, req) {
  if (!presentedToken) throw new ApiError(401, 'Not authenticated');

  const tokenHash = RefreshToken.hashToken(presentedToken);
  const consumed = await RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { revokedAt: new Date() } },
    { new: false }
  );

  if (!consumed) {
    // Either the token never existed, or it was already spent. The second
    // case is the one that matters: a spent token being presented again is
    // a replay or a stolen cookie, and the whole family goes.
    const existing = await RefreshToken.findOne({ tokenHash }).select('family userId');
    if (existing) {
      await RefreshToken.updateMany(
        { family: existing.family, revokedAt: null },
        { $set: { revokedAt: new Date() } }
      );
      audit.record('refresh_reuse_detected', { req, userId: existing.userId });
    }
    throw new ApiError(401, 'Session expired. Please sign in again.');
  }

  const user = await User.findById(consumed.userId);
  if (!user) {
    await RefreshToken.updateMany({ family: consumed.family }, { $set: { revokedAt: new Date() } });
    throw new ApiError(401, 'Session expired. Please sign in again.');
  }

  const session = await issueSession(user, req, { family: consumed.family });
  // Bookkeeping only - the predecessor is already revoked, so this being
  // lost to a crash costs nothing but a broken link in the audit chain.
  await RefreshToken.updateOne(
    { _id: consumed._id },
    { $set: { replacedByHash: RefreshToken.hashToken(session.refreshToken) } }
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

// --- Out-of-band flows ------------------------------------------------

/**
 * Mints a single-use token, invalidating any outstanding one of the same
 * purpose for this user, and returns the plaintext exactly once.
 *
 * Superseding matters: without it, every "resend" leaves another live
 * credential in another inbox, and a link the user believes they replaced
 * still opens the account.
 */
async function issueVerificationToken(user, purpose, ttlSeconds, req) {
  const token = generateRefreshToken(); // same 48 bytes of CSPRNG output
  await VerificationToken.updateMany(
    { userId: user._id, purpose, usedAt: null },
    { $set: { usedAt: new Date() } }
  );
  await VerificationToken.create({
    userId: user._id,
    purpose,
    tokenHash: VerificationToken.hashToken(token),
    email: user.email,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    ip: String(req?.ip || '').slice(0, 64),
  });
  return token;
}

/**
 * Redeems a token atomically.
 *
 * The `usedAt: null` term in the *filter* is what makes it single use:
 * checking and then marking would let two requests arriving together both
 * pass the check. `email` is compared against the account's current
 * address so a token mailed to an address that has since been corrected
 * stops working - otherwise a reset link sent to a stale (or attacker
 * controlled) address still opens the account afterwards.
 */
async function consumeVerificationToken(token, purpose) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const record = await VerificationToken.findOneAndUpdate(
    {
      tokenHash: VerificationToken.hashToken(token),
      purpose,
      usedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
    { new: true }
  );
  if (!record) return null;

  const user = await User.findById(record.userId);
  if (!user || user.email !== record.email) return null;
  return { user, record };
}

/**
 * Starts a password reset.
 *
 * Answers identically whether or not the address has an account. That is
 * not decoration: a "we couldn't find that email" response makes this
 * endpoint a better account-existence oracle than the login form, which
 * goes to some trouble not to be one.
 */
async function requestPasswordReset({ email }, req) {
  const normalised = String(email).toLowerCase();
  audit.record('password_reset_requested', { req, email: normalised, outcome: 'success' });

  const user = await User.findOne({ email: normalised });
  if (!user) return { sent: false };

  const token = await issueVerificationToken(
    user,
    'password_reset',
    env.auth.passwordResetTtlSeconds,
    req
  );
  await mailer.sendPasswordReset({ to: user.email, token });
  return { sent: true, token: env.isTest ? token : undefined };
}

/**
 * Completes a password reset.
 *
 * Every existing session goes with it. A reset is what someone does when
 * they believe their account is compromised, so leaving the attacker's
 * refresh cookie working would defeat the point of doing it.
 */
async function resetPassword({ token, password }, req) {
  const consumed = await consumeVerificationToken(token, 'password_reset');
  if (!consumed) {
    throw new ApiError(400, 'That reset link is invalid or has expired. Request a new one.');
  }

  const { user } = consumed;
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        passwordHash: await User.hashPassword(password),
        loginFailures: [],
        // Proving control of the mailbox is at least as strong as clicking
        // a verification link, so a reset verifies the address too.
        emailVerifiedAt: user.emailVerifiedAt || new Date(),
      },
      $inc: { tokenVersion: 1 },
    }
  );
  await RefreshToken.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });

  audit.record('password_reset_completed', {
    req,
    userId: user._id,
    email: user.email,
    outcome: 'success',
  });
  return { user };
}

/** Changes the password of an already-authenticated user. Requires the
 * current one: a session that was left open on a shared machine must not
 * be enough to lock the real owner out. */
async function changePassword(userId, { currentPassword, newPassword }, req) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new ApiError(401, 'Not authenticated');

  if (!(await user.verifyPassword(String(currentPassword)))) {
    audit.record('login_failed', {
      req,
      userId: user._id,
      email: user.email,
      detail: { reason: 'bad_current_password_on_change' },
    });
    throw new ApiError(401, 'Current password is incorrect');
  }

  await User.updateOne(
    { _id: user._id },
    { $set: { passwordHash: await User.hashPassword(newPassword) }, $inc: { tokenVersion: 1 } }
  );
  await RefreshToken.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  audit.record('password_changed', { req, userId: user._id, email: user.email, outcome: 'success' });
  return { user };
}

async function requestEmailVerification(user, req) {
  if (user.emailVerifiedAt) return { sent: false, alreadyVerified: true };
  const token = await issueVerificationToken(
    user,
    'email_verification',
    env.auth.emailVerificationTtlSeconds,
    req
  );
  await mailer.sendEmailVerification({ to: user.email, token });
  audit.record('email_verification_requested', {
    req,
    userId: user._id,
    email: user.email,
    outcome: 'success',
  });
  return { sent: true, token: env.isTest ? token : undefined };
}

async function verifyEmail({ token }, req) {
  const consumed = await consumeVerificationToken(token, 'email_verification');
  if (!consumed) {
    throw new ApiError(400, 'That confirmation link is invalid or has expired. Request a new one.');
  }
  await User.updateOne({ _id: consumed.user._id }, { $set: { emailVerifiedAt: new Date() } });
  audit.record('email_verified', {
    req,
    userId: consumed.user._id,
    email: consumed.user.email,
    outcome: 'success',
  });
  return { user: consumed.user };
}

// --- Multi-factor enrolment -------------------------------------------

/**
 * Generates a secret and the QR-code URI for it, without enabling
 * anything.
 *
 * Enrolment is two steps on purpose: a user who scans a code, loses the
 * phone before confirming, and finds MFA already required would be locked
 * out by the very act of setting it up. Nothing changes until they prove
 * they can read a code from the secret.
 */
async function beginMfaEnrolment(userId) {
  const user = await User.findById(userId).select('+mfaSecret');
  if (!user) throw new ApiError(401, 'Not authenticated');
  if (user.mfaEnabled) throw new ApiError(409, 'Multi-factor authentication is already enabled');

  const secret = totp.generateSecret();
  await User.updateOne({ _id: user._id }, { $set: { mfaSecret: secret } });

  return {
    secret,
    otpauthUri: totp.otpauthUri({
      secret,
      account: user.email,
      issuer: env.auth.issuer,
    }),
  };
}

/** Confirms enrolment and returns the recovery codes - the only time they
 * are ever readable. */
async function enableMfa(userId, { code }, req) {
  const user = await User.findById(userId).select('+mfaSecret +mfaRecoveryCodes');
  if (!user) throw new ApiError(401, 'Not authenticated');
  if (user.mfaEnabled) throw new ApiError(409, 'Multi-factor authentication is already enabled');
  if (!user.mfaSecret) throw new ApiError(409, 'Start enrolment first');

  const { valid, step } = totp.verify(user.mfaSecret, String(code), { window: env.auth.totpWindow });
  if (!valid) {
    audit.record('mfa_challenge_failed', { req, userId: user._id, email: user.email });
    throw new ApiError(400, 'That verification code is not valid');
  }

  const codes = totp.generateRecoveryCodes(env.auth.mfaRecoveryCodeCount);
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(c, env.auth.bcryptRounds)));
  await User.updateOne(
    { _id: user._id },
    { $set: { mfaEnabledAt: new Date(), mfaRecoveryCodes: hashes, mfaLastUsedStep: step } }
  );

  audit.record('mfa_enabled', { req, userId: user._id, email: user.email, outcome: 'success' });
  return { recoveryCodes: codes };
}

/** Turning MFA off requires the password *and* a current factor - turning
 * a protection off has to be at least as hard as using it, or an attacker
 * with a live session simply removes it. */
async function disableMfa(userId, { password, code, recoveryCode }, req) {
  const user = await User.findById(userId).select(
    '+passwordHash +mfaSecret +mfaRecoveryCodes +mfaLastUsedStep'
  );
  if (!user) throw new ApiError(401, 'Not authenticated');
  if (!user.mfaEnabled) return { disabled: false };

  if (!(await user.verifyPassword(String(password)))) {
    throw new ApiError(401, 'Current password is incorrect');
  }
  const result = await verifySecondFactor(user, { mfaCode: code, recoveryCode });
  if (!result.ok) {
    audit.record('mfa_challenge_failed', { req, userId: user._id, email: user.email });
    throw new ApiError(401, result.message, { code: result.code });
  }

  await User.updateOne(
    { _id: user._id },
    { $set: { mfaEnabledAt: null, mfaSecret: null, mfaRecoveryCodes: [], mfaLastUsedStep: 0 } }
  );
  audit.record('mfa_disabled', { req, userId: user._id, email: user.email, outcome: 'success' });
  return { disabled: true };
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  logoutEverywhere,
  issueSession,
  requestPasswordReset,
  resetPassword,
  changePassword,
  requestEmailVerification,
  verifyEmail,
  beginMfaEnrolment,
  enableMfa,
  disableMfa,
  verifySecondFactor,
  consumeVerificationToken,
  sourceOf,
  INVALID_CREDENTIALS,
};

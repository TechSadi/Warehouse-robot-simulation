// Loads and validates process environment variables in one place so the
// rest of the app never touches `process.env` directly.
require('dotenv').config();

const crypto = require('crypto');

const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

/**
 * Secrets are hard requirements in production - booting with a default or
 * generated signing key would silently invalidate every issued token on
 * restart (and, worse, invite someone to ship the placeholder). Outside
 * production we fall back to a per-process random value so `npm test` and
 * a fresh local checkout work with no setup; tokens simply don't survive a
 * restart there, which is exactly the right trade-off for a dev machine.
 */
function requireSecret(name, minLength = 32) {
  const value = process.env[name];
  if (value && value.length >= minLength) return value;

  if (isProduction) {
    throw new Error(
      `[env] ${name} is required in production and must be at least ${minLength} characters. ` +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
    );
  }
  if (value) {
    console.warn(`[env] ${name} is shorter than ${minLength} characters - using it anyway (non-production).`);
    return value;
  }
  return crypto.randomBytes(48).toString('base64url');
}

const required = ['MONGO_URI'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  // We warn instead of throwing so the server can still boot for local
  // frontend/API smoke-testing before a real database is wired up.
  // db.js escalates this into a clear runtime warning on connection.
  console.warn(
    `[env] Missing recommended environment variables: ${missing.join(', ')}. ` +
      'Copy backend/.env.example to backend/.env and fill these in.'
  );
}

const clientOrigins = (process.env.CLIENT_ORIGINS || (isProduction ? '' : 'http://localhost:5173'))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (isProduction && clientOrigins.length === 0) {
  throw new Error(
    '[env] CLIENT_ORIGINS must list the deployed frontend origin(s) in production. ' +
      'A credentialed API must never fall back to an open/wildcard CORS policy.'
  );
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/warehouse-sim',
  clientOrigins,
  socketPath: process.env.SOCKET_PATH || '/socket.io',
  // How often the server-owned per-warehouse tick loop advances the
  // simulation (Milestone 11 - see sockets/tickLoopManager.js). Overridable
  // so integration tests can run it fast instead of waiting on the 500ms
  // production cadence.
  tickIntervalMs: Number(process.env.TICK_INTERVAL_MS) || 500,
  isProduction,
  isTest,

  // --- Simulation runtime ----------------------------------------------
  simulation: {
    /**
     * Ceiling on how many warehouse engines stay cached in memory, and how
     * long an unused one survives. The cache was previously unbounded in
     * the number of warehouses ever touched since the process started -
     * fine for a handful, a slow leak for a deployment with many. A
     * warehouse that is actively ticking is pinned and never evicted, so
     * these only govern warehouses nobody is running.
     *
     * Zero disables the corresponding half of the sweep.
     */
    maxCachedEngines: Number(process.env.MAX_CACHED_ENGINES) || 64,
    engineIdleTtlMs: Number(process.env.ENGINE_IDLE_TTL_MS) || 30 * 60 * 1000,
    /**
     * How long a simulation may keep running with nobody watching it (see
     * `background: true` on `simulation:start`). Unattended work needs a
     * ceiling or a forgotten browser tab leaves a warehouse ticking for
     * the life of the process.
     */
    maxBackgroundSeconds: Number(process.env.MAX_BACKGROUND_SECONDS) || 60 * 60,
    /**
     * The largest simulation step a single tick may apply. The automatic
     * loop measures real elapsed time rather than assuming its own cadence
     * (see sockets/tickLoopManager.js), so a stalled process would
     * otherwise come back and advance the world by however long it was
     * gone. Capping turns that into a bounded catch-up and a visible
     * `laggedSeconds` counter instead of a teleporting fleet.
     */
    maxTickDeltaSeconds: Number(process.env.MAX_TICK_DELTA_SECONDS) || 2,
    /**
     * Cross-process warehouse leases. One Node process may own a
     * warehouse's tick loop at a time; a second instance running against
     * the same database refuses to tick a warehouse another instance
     * holds, rather than running a second simulation of it. Off under test
     * (there is no shared database to coordinate through) and off when
     * explicitly disabled for a known single-instance deployment.
     */
    leasesEnabled: process.env.SIMULATION_LEASES
      ? process.env.SIMULATION_LEASES === 'true'
      : !isTest,
    leaseTtlSeconds: Number(process.env.SIMULATION_LEASE_TTL_SECONDS) || 30,
  },

  // --- Authentication -------------------------------------------------
  // Separate signing keys per token type: a stolen/leaked access secret
  // must not also let an attacker mint refresh tokens (and vice versa).
  auth: {
    accessSecret: requireSecret('JWT_ACCESS_SECRET'),
    refreshSecret: requireSecret('JWT_REFRESH_SECRET'),
    // Short access-token lifetime keeps the blast radius of a leaked token
    // small; the refresh cookie (rotated, revocable, stored hashed) is what
    // actually keeps a user signed in.
    accessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS) || 15 * 60,
    refreshTtlSeconds: Number(process.env.JWT_REFRESH_TTL_SECONDS) || 30 * 24 * 60 * 60,
    issuer: process.env.JWT_ISSUER || 'warehouse-robot-simulation',
    audience: process.env.JWT_AUDIENCE || 'warehouse-robot-simulation-client',
    bcryptRounds: Number(process.env.BCRYPT_ROUNDS) || (isTest ? 4 : 12),
    // Login throttling (credential stuffing / brute force). Counted and
    // applied *per source network* rather than per account, so lockout
    // cannot be used to keep someone else out of their own account - see
    // the `loginFailures` field in models/User.js.
    maxFailedLogins: Number(process.env.MAX_FAILED_LOGINS) || 8,
    lockoutSeconds: Number(process.env.LOGIN_LOCKOUT_SECONDS) || 15 * 60,
    /** How many distinct source buckets one account tracks before the
     * oldest are discarded. Bounds the growth an attacker rotating
     * addresses can force on a single document. */
    maxLoginFailureBuckets: Number(process.env.MAX_LOGIN_FAILURE_BUCKETS) || 20,

    /** A reset token is a live credential - whoever holds it becomes the
     * user - so it is short lived. A verification token is not, and a user
     * may not read their mail for a day. */
    passwordResetTtlSeconds: Number(process.env.PASSWORD_RESET_TTL_SECONDS) || 30 * 60,
    emailVerificationTtlSeconds:
      Number(process.env.EMAIL_VERIFICATION_TTL_SECONDS) || 24 * 60 * 60,
    /**
     * Whether an unverified address may use the API at all.
     *
     * Off by default, deliberately: turning it on without a working mail
     * transport locks every account out of a system that was working a
     * moment ago. Deployments that have configured MAIL_TRANSPORT should
     * turn it on; the flow works either way, and `emailVerified` is
     * reported to the client regardless.
     */
    requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'true',

    /** How many steps either side of the current one a TOTP code is
     * accepted for. One (± 30 seconds) absorbs ordinary clock drift;
     * widening it multiplies the guess space. */
    totpWindow: Number(process.env.TOTP_WINDOW) || 1,
    mfaRecoveryCodeCount: Number(process.env.MFA_RECOVERY_CODE_COUNT) || 10,
  },

  // --- Outbound mail ----------------------------------------------------
  // See services/mailer.js. Production must choose explicitly: a reset
  // link printed to a log is not a delivered email, and defaulting to
  // `console` there would ship a password reset that silently does not
  // work.
  mail: {
    transport: process.env.MAIL_TRANSPORT || (isProduction ? 'none' : 'console'),
    webhookUrl: process.env.MAIL_WEBHOOK_URL || '',
    webhookToken: process.env.MAIL_WEBHOOK_TOKEN || '',
    webhookTimeoutMs: Number(process.env.MAIL_WEBHOOK_TIMEOUT_MS) || 5000,
    /** Where the links in those emails point. The frontend owns
     * /reset-password and /verify-email; this is its origin. */
    appBaseUrl:
      process.env.APP_BASE_URL || clientOrigins[0] || 'http://localhost:5173',
  },

  // --- Rate limiting ----------------------------------------------------
  // Only the registration ceiling is configurable, and only outside
  // production. A browser-driven E2E suite registers real accounts through
  // the real form and needs more than the production allowance of five per
  // hour; every other limit is generous enough that no test has to touch
  // it. Ignoring the override in production is deliberate - this limit is
  // what stops the endpoint being used to enumerate which email addresses
  // have accounts, and an env var is exactly how that protection would get
  // turned off by accident.
  rateLimits: {
    registrationsPerHour: isProduction
      ? 5
      : Number(process.env.REGISTER_RATE_LIMIT_MAX) || 5,
    /**
     * Where the limiter counters live.
     *
     * `express-rate-limit`'s default memory store is per process, so
     * limits are neither shared across instances nor survive a redeploy -
     * fine on a single free-tier instance, and a hole the moment there are
     * two. `mongo` keeps them in the database this app already has, which
     * makes them shared and durable without adding Redis to the stack.
     * Defaults to mongo in production and memory elsewhere, because a test
     * suite has no database and does not need shared counters anyway.
     */
    store: process.env.RATE_LIMIT_STORE || (isProduction ? 'mongo' : 'memory'),
  },

  cookies: {
    // Vercel (frontend) and Render (backend) are different registrable
    // domains, so the auth cookies are cross-site in production and must
    // be SameSite=None to be sent at all - which browsers only permit
    // together with Secure. Locally everything is same-site through
    // Vite's proxy, where Lax is both sufficient and CSRF-safer.
    sameSite: process.env.COOKIE_SAMESITE || (isProduction ? 'none' : 'lax'),
    secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProduction,
    domain: process.env.COOKIE_DOMAIN || undefined,
  },
};

module.exports = env;

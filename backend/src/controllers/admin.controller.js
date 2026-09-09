const mongoose = require('mongoose');
const User = require('../models/User');
const Warehouse = require('../models/Warehouse');
const RefreshToken = require('../models/RefreshToken');
const SecurityEvent = require('../models/SecurityEvent');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, buildMeta } = require('../utils/pagination');
const { ApiError } = require('../middleware/errorHandler');
const audit = require('../services/securityAudit');
const simulationManager = require('../services/simulationManager');

/**
 * The administrative surface.
 *
 * `requireRole` existed and no route used it, which made the `admin` role a
 * field on a model rather than a capability - and left the audit trail
 * this phase added with no way to read it. The gap it fills is narrow and
 * deliberate:
 *
 *  - **Read the audit trail.** An audit trail nobody can read is a log
 *    file with extra steps.
 *  - **See the accounts.** Enough to answer "is this account locked, is it
 *    verified, does it have MFA" when a user asks for help.
 *  - **Revoke sessions.** The one action that has to be available to
 *    somebody other than the account holder, because the case for it is
 *    exactly the case where the account holder has lost control.
 *
 * What is deliberately absent is as important. There is no impersonation,
 * no password setting, no reading or writing another user's warehouses,
 * robots or orders. Authorization in this application is ownership-based
 * (middleware/authorize.js) and an admin bypass would make every ownership
 * check in the app conditional on a role - the exact shape of bug that
 * makes "admin" the most valuable account on a system to compromise.
 * Admins here can see *about* users, not *as* them.
 *
 * Every action is written to the audit trail, including the reads: an
 * administrator looking through the security log is itself a security
 * event.
 */

/** Never `User.find()` unprojected - the password hash, the MFA secret and
 * the recovery codes are all `select: false`, and a future field might not
 * be. An explicit projection means a new sensitive field is excluded by
 * default rather than by remembering. */
const USER_FIELDS = 'email name role createdAt lastLoginAt emailVerifiedAt mfaEnabledAt globalFailedLogins';

function presentUser(doc) {
  return {
    id: String(doc._id),
    email: doc.email,
    name: doc.name,
    role: doc.role,
    createdAt: doc.createdAt,
    lastLoginAt: doc.lastLoginAt,
    emailVerified: Boolean(doc.emailVerifiedAt),
    mfaEnabled: Boolean(doc.mfaEnabledAt),
    failedLoginsAllTime: doc.globalFailedLogins || 0,
  };
}

const listUsers = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.email) filter.email = String(req.query.email).toLowerCase();
  if (req.query.role) filter.role = req.query.role;

  const [items, total] = await Promise.all([
    User.find(filter).select(USER_FIELDS).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);

  audit.record('admin_action', {
    req,
    userId: req.userId,
    detail: { action: 'list_users', filter },
    outcome: 'success',
  });
  res.json({
    success: true,
    data: items.map(presentUser),
    meta: buildMeta({ page, limit, total }),
  });
});

const getUser = asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new ApiError(404, 'User not found');
  const user = await User.findById(req.params.id).select(`${USER_FIELDS} +loginFailures`);
  if (!user) throw new ApiError(404, 'User not found');

  const [warehouses, activeSessions] = await Promise.all([
    Warehouse.countDocuments({ ownerId: user._id }),
    RefreshToken.countDocuments({ userId: user._id, revokedAt: null, expiresAt: { $gt: new Date() } }),
  ]);

  audit.record('admin_action', {
    req,
    userId: req.userId,
    detail: { action: 'get_user', target: String(user._id) },
    outcome: 'success',
  });
  res.json({
    success: true,
    data: {
      ...presentUser(user),
      warehouses,
      activeSessions,
      // Which *sources* are currently locked out of this account, which is
      // what a support question about "I can't sign in" actually needs.
      lockouts: (user.loginFailures || [])
        .filter((b) => b.lockUntil && b.lockUntil.getTime() > Date.now())
        .map((b) => ({ source: b.source, until: b.lockUntil })),
    },
  });
});

/**
 * Signs a user out everywhere and clears any lockout on their account.
 *
 * The two together, because they are the two halves of one support case:
 * "my account was compromised" needs the attacker's sessions gone, and "I
 * am locked out" needs the counters cleared. Bumping `tokenVersion` is
 * what makes already-issued access tokens stale without an access-token
 * blacklist.
 */
const revokeUserSessions = asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new ApiError(404, 'User not found');
  const user = await User.findById(req.params.id).select('_id email');
  if (!user) throw new ApiError(404, 'User not found');

  const [revoked] = await Promise.all([
    RefreshToken.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } }),
    User.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 }, $set: { loginFailures: [] } }),
  ]);

  audit.record('admin_action', {
    req,
    userId: req.userId,
    email: user.email,
    detail: { action: 'revoke_sessions', target: String(user._id) },
    outcome: 'success',
  });
  res.json({
    success: true,
    data: {
      message: 'Sessions revoked and lockouts cleared.',
      sessionsRevoked: revoked?.modifiedCount ?? 0,
    },
  });
});

/** The audit trail itself - see models/SecurityEvent.js. */
const listSecurityEvents = asyncHandler(async (req, res) => {
  const { page, limit, skip } = parsePagination(req.query);
  const filter = {};
  if (req.query.type) filter.type = req.query.type;
  if (req.query.email) filter.email = String(req.query.email).toLowerCase();
  if (req.query.outcome) filter.outcome = req.query.outcome;
  if (req.query.userId && mongoose.Types.ObjectId.isValid(req.query.userId)) {
    filter.userId = req.query.userId;
  }

  const [items, total] = await Promise.all([
    SecurityEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    SecurityEvent.countDocuments(filter),
  ]);

  audit.record('admin_action', {
    req,
    userId: req.userId,
    detail: { action: 'list_security_events', filter },
    outcome: 'success',
  });
  res.json({ success: true, data: items, meta: buildMeta({ page, limit, total }) });
});

/** Operational state an administrator would otherwise have to read a log
 * to find: how many warehouses this instance is holding in memory, how
 * many it is actively simulating, and how long it has been up. */
const getSystemStatus = asyncHandler(async (req, res) => {
  const [users, warehouses] = await Promise.all([
    User.countDocuments({}),
    Warehouse.countDocuments({}),
  ]);

  res.json({
    success: true,
    data: {
      instance: require('../services/instanceLease').INSTANCE_ID,
      uptimeSeconds: Math.round(process.uptime()),
      database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      users,
      warehouses,
      cachedEngines: simulationManager.engines.size,
      simulatingWarehouses: simulationManager.pinned.size,
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
  });
});

module.exports = { listUsers, getUser, revokeUserSessions, listSecurityEvents, getSystemStatus };

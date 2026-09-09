const { Router } = require('express');
const { query } = require('express-validator');
const controller = require('../controllers/admin.controller');
const validate = require('../middleware/validate');
const { requireAuth, requireRole } = require('../middleware/auth');
const csrfProtection = require('../middleware/csrf');
const { apiLimiter } = require('../middleware/rateLimit');
const { TYPES } = require('../models/SecurityEvent');

const router = Router();

/**
 * Gated at the router, not per route.
 *
 * Same reasoning as every other router in this app: a per-route opt-in
 * fails by omission, and the failure mode of a forgotten line here is an
 * administrative endpoint open to any signed-in user. `requireAuth` runs
 * first so an anonymous caller gets 401 rather than 403 - "you are not
 * signed in" and "you are signed in and not allowed" are genuinely
 * different answers, and neither leaks anything: the routes themselves are
 * not secret.
 */
router.use(requireAuth, requireRole('admin'), apiLimiter);

router.get(
  '/users',
  [
    query('email').optional().isString().trim().toLowerCase().isLength({ max: 254 }),
    query('role').optional().isIn(['user', 'admin']),
  ],
  validate,
  controller.listUsers
);

router.get('/users/:id', controller.getUser);

// A write, so it is CSRF-protected like every other cookie-authenticated
// state change - being able to sign someone out from a third-party page is
// a nuisance attack, and being able to do it *as an admin* to an arbitrary
// account is a better one.
router.post('/users/:id/revoke-sessions', csrfProtection, controller.revokeUserSessions);

router.get(
  '/security-events',
  [
    query('type').optional().isIn(TYPES),
    query('outcome').optional().isIn(['success', 'failure']),
    query('email').optional().isString().trim().toLowerCase().isLength({ max: 254 }),
    query('userId').optional().isString().isLength({ max: 40 }),
  ],
  validate,
  controller.listSecurityEvents
);

router.get('/status', controller.getSystemStatus);

module.exports = router;

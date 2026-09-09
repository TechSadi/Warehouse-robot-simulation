const { Router } = require('express');
const { body } = require('express-validator');
const rateLimit = require('express-rate-limit');
const controller = require('../controllers/telemetry.controller');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const env = require('../config/env');

const router = Router();

router.use(requireAuth);

/**
 * Tighter than the write limiter, and on purpose.
 *
 * The failure mode this guards against is not an attacker - it is a bug.
 * A render error inside a component that re-renders on every tick would
 * report itself twice a second forever, and the endpoint would happily
 * write all of it. The client dedupes and caps its own reporting
 * (frontend/src/api/telemetry.js), but the server cannot rely on a client
 * that is by definition already misbehaving.
 */
const telemetryLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.isTest,
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => `telemetry:${req.userId}`,
  message: { success: false, error: { message: 'Too many error reports. Please slow down.' } },
});

// No CSRF token required, deliberately. This is reached from an error
// path - frequently one where the app has already failed to render - and
// making the report depend on more of the app still working is how a
// telemetry endpoint ends up silent exactly when it matters. It is safe to
// exempt because the endpoint has no side effect worth forging: it writes
// one server-authored log line, scoped to the caller's own account, with
// nothing the caller can read back that they could not read anyway.
router.post(
  '/client-errors',
  telemetryLimiter,
  [
    body('message').isString().isLength({ min: 1, max: 2000 }),
    body('name').optional().isString().isLength({ max: 200 }),
    body('componentStack').optional().isString().isLength({ max: 20000 }),
    body('stack').optional().isString().isLength({ max: 20000 }),
    body('url').optional().isString().isLength({ max: 2000 }),
    body('boundary').optional().isString().isLength({ max: 80 }),
    body('warehouseId').optional().isMongoId(),
  ],
  validate,
  controller.reportClientError
);

module.exports = router;

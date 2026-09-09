const { Router } = require('express');
const { body } = require('express-validator');
const controller = require('../controllers/auth.controller');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const csrfProtection = require('../middleware/csrf');
const { authLimiter, registerLimiter } = require('../middleware/rateLimit');
const { EMAIL_PATTERN } = require('../models/User');

const router = Router();

// 12 is a deliberate floor rather than the more common 8: this is a
// single-factor login with no email verification behind it, so the
// password is the entire defence. `isStrongPassword` additionally rejects
// the trivially-guessable shapes that dominate credential-stuffing lists.
// The 200-char ceiling matters too - bcrypt only reads the first 72 bytes,
// and hashing an unbounded string is free CPU for an attacker.
const passwordRules = body('password')
  .isString()
  .withMessage('password is required')
  .isLength({ min: 12, max: 200 })
  .withMessage('password must be between 12 and 200 characters')
  .isStrongPassword({ minLength: 12, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 0 })
  .withMessage('password must contain upper case, lower case, and a number');

const emailRules = body('email')
  .isString()
  .withMessage('email is required')
  .trim()
  .toLowerCase()
  .isLength({ max: 254 })
  .matches(EMAIL_PATTERN)
  .withMessage('email must be a valid address');

router.post(
  '/register',
  registerLimiter,
  authLimiter,
  [emailRules, passwordRules, body('name').optional().isString().trim().isLength({ max: 80 })],
  validate,
  controller.register
);

router.post(
  '/login',
  authLimiter,
  [
    emailRules,
    // Only presence and a sane length here - applying the strength rules
    // to a *login* would tell an attacker which of their guesses could
    // possibly be a real password on this system.
    body('password').isString().isLength({ min: 1, max: 200 }).withMessage('password is required'),
  ],
  validate,
  controller.login
);

// Rotates the refresh cookie. Rate-limited like the other credential
// endpoints because a stolen-token replay attempt lands here.
router.post('/refresh', authLimiter, controller.refresh);

// CSRF-protected: logout is state-changing, and being able to sign a user
// out from a third-party page is a real (if low-severity) nuisance attack.
router.post('/logout', csrfProtection, controller.logout);
router.post('/logout-all', csrfProtection, requireAuth, controller.logoutAll);

router.get('/me', requireAuth, controller.me);

module.exports = router;

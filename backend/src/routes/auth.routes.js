const { Router } = require('express');
const { body } = require('express-validator');
const controller = require('../controllers/auth.controller');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const csrfProtection = require('../middleware/csrf');
const { authLimiter, registerLimiter, accountRecoveryLimiter } = require('../middleware/rateLimit');
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

// Shape only. A six-digit code has no "strength" to check, and rejecting
// anything else here keeps a non-numeric value out of the HMAC comparison.
const mfaCodeRules = body('mfaCode')
  .optional()
  .isString()
  .matches(/^\d{6}$/)
  .withMessage('mfaCode must be six digits');

const recoveryCodeRules = body('recoveryCode')
  .optional()
  .isString()
  .isLength({ min: 6, max: 32 })
  .withMessage('recoveryCode is not a valid code');

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
    mfaCodeRules,
    recoveryCodeRules,
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

// --- Account recovery --------------------------------------------------
//
// Both halves are unauthenticated by necessity: the whole point is that
// the caller cannot sign in. That makes them the softest surface here
// after login, so both carry the strict recovery limiter as well as the
// general auth one, and neither reveals whether an address has an account.

router.post(
  '/password/forgot',
  accountRecoveryLimiter,
  authLimiter,
  [emailRules],
  validate,
  controller.forgotPassword
);

router.post(
  '/password/reset',
  accountRecoveryLimiter,
  authLimiter,
  [
    body('token').isString().isLength({ min: 20, max: 200 }).withMessage('token is required'),
    // The full strength rules apply here: unlike a login, this *sets* a
    // password, so refusing a weak one tells the attacker nothing they did
    // not already choose.
    passwordRules,
  ],
  validate,
  controller.resetPassword
);

// Authenticated, and CSRF-protected like every other cookie-authenticated
// write: being able to change someone's password from a third-party page
// would be an account takeover, not a nuisance.
router.post(
  '/password/change',
  csrfProtection,
  requireAuth,
  [
    body('currentPassword').isString().isLength({ min: 1, max: 200 }),
    body('newPassword').custom((value, { req }) => {
      if (value === req.body.currentPassword) {
        throw new Error('newPassword must differ from currentPassword');
      }
      return true;
    }),
    body('newPassword')
      .isString()
      .isLength({ min: 12, max: 200 })
      .isStrongPassword({ minLength: 12, minLowercase: 1, minUppercase: 1, minNumbers: 1, minSymbols: 0 })
      .withMessage('newPassword must contain upper case, lower case, and a number'),
  ],
  validate,
  controller.changePassword
);

// --- Email verification ------------------------------------------------

router.post(
  '/email/verify/request',
  accountRecoveryLimiter,
  csrfProtection,
  requireAuth,
  controller.requestEmailVerification
);

// Deliberately unauthenticated: the link is followed from an email client,
// which is frequently not the browser holding the session. The token is
// the credential.
router.post(
  '/email/verify',
  accountRecoveryLimiter,
  [body('token').isString().isLength({ min: 20, max: 200 }).withMessage('token is required')],
  validate,
  controller.verifyEmail
);

// --- Multi-factor authentication ---------------------------------------

router.post('/mfa/setup', csrfProtection, requireAuth, controller.beginMfaEnrolment);

router.post(
  '/mfa/enable',
  authLimiter,
  csrfProtection,
  requireAuth,
  [body('code').isString().matches(/^\d{6}$/).withMessage('code must be six digits')],
  validate,
  controller.enableMfa
);

router.post(
  '/mfa/disable',
  authLimiter,
  csrfProtection,
  requireAuth,
  [
    body('password').isString().isLength({ min: 1, max: 200 }),
    body('code').optional().isString().matches(/^\d{6}$/).withMessage('code must be six digits'),
    recoveryCodeRules,
  ],
  validate,
  controller.disableMfa
);

module.exports = router;

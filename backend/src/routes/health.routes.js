const { Router } = require('express');
const { getHealth, getHealthDetails } = require('../controllers/health.controller');
const { requireAuth } = require('../middleware/auth');

const router = Router();

// The only unauthenticated route in this file, and it reports only that
// the process is serving requests - see the controller for why the rest
// moved behind a session.
router.get('/', getHealth);

router.get('/details', requireAuth, getHealthDetails);

module.exports = router;

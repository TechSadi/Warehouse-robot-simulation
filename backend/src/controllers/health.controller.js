const mongoose = require('mongoose');

const READY_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

/**
 * The public probe.
 *
 * Deliberately just "is this process serving requests" - a status and a
 * name, nothing else. It used to report uptime and the database connection
 * state to anyone who asked, which is a small but real unauthenticated
 * disclosure: uptime dates a deployment (and so narrows which version is
 * running), and a database state flipping to `disconnected` tells an
 * attacker exactly when the service is least able to defend itself.
 *
 * Nothing needs that to be public. A platform health check needs a 200 and
 * a fast one; an operator needs the detail and can sign in for it. So the
 * detail moved to `/api/health/details` behind `requireAuth`, and this
 * endpoint answers the question it is actually asked.
 */
function getHealth(req, res) {
  res.json({
    success: true,
    data: {
      service: 'warehouse-robot-simulation-backend',
      status: 'ok',
    },
  });
}

/** The operator's view. Authenticated - see the note above. */
function getHealthDetails(req, res) {
  res.json({
    success: true,
    data: {
      service: 'warehouse-robot-simulation-backend',
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      database: READY_STATES[mongoose.connection.readyState] || 'unknown',
      timestamp: new Date().toISOString(),
    },
  });
}

module.exports = { getHealth, getHealthDetails };

const mongoose = require('mongoose');

const READY_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

function getHealth(req, res) {
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

module.exports = { getHealth };

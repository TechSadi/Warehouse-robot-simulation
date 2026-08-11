const http = require('http');

const app = require('./app');
const env = require('./config/env');
const connectDB = require('./config/db');
const initSockets = require('./sockets');

async function start() {
  // Connect in the background rather than blocking startup on it: the
  // HTTP server and Socket.IO transport don't depend on Mongo being up,
  // and gating listen() on a slow/unavailable DB would needlessly delay
  // health checks and frontend connectivity checks.
  connectDB();

  const httpServer = http.createServer(app);
  initSockets(httpServer);
  // Milestone 11's server-owned tick loops (one setInterval per active
  // warehouse) need to be cleared explicitly on shutdown, or they'd keep
  // firing (and keep the process alive) after httpServer.close() below.

  httpServer.listen(env.port, '0.0.0.0', () => {
    console.log(`[server] Listening on port ${env.port} (${env.nodeEnv})`);
  });

  const shutdown = (signal) => {
    console.log(`[server] Received ${signal}, shutting down gracefully...`);
    if (initSockets.tickLoopManager) initSockets.tickLoopManager.stopAll();
    httpServer.close(() => {
      console.log('[server] Closed remaining connections.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  console.error('[server] Fatal error during startup:', err);
  process.exit(1);
});

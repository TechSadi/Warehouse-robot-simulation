// Loads and validates process environment variables in one place so the
// rest of the app never touches `process.env` directly.
require('dotenv').config();

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

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/warehouse-sim',
  clientOrigins: (process.env.CLIENT_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  socketPath: process.env.SOCKET_PATH || '/socket.io',
  // How often the server-owned per-warehouse tick loop advances the
  // simulation (Milestone 11 - see sockets/tickLoopManager.js). Overridable
  // so integration tests can run it fast instead of waiting on the 500ms
  // production cadence.
  tickIntervalMs: Number(process.env.TICK_INTERVAL_MS) || 500,
  isProduction: process.env.NODE_ENV === 'production',
};

module.exports = env;

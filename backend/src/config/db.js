const mongoose = require('mongoose');
const env = require('./env');

mongoose.set('strictQuery', true);

/**
 * Connects to MongoDB. In production a failed connection is fatal because
 * every collection-backed route depends on it. In development we log a
 * loud warning but let the server keep running, so the frontend layout,
 * health check, and Socket.IO wiring can still be verified without a
 * database on hand.
 */
async function connectDB() {
  try {
    await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`[db] Connected to MongoDB at ${redactUri(env.mongoUri)}`);
  } catch (err) {
    console.error(`[db] Failed to connect to MongoDB: ${err.message}`);
    if (env.isProduction) {
      throw err;
    }
    console.warn(
      '[db] Continuing without a database connection (development mode). ' +
        'Start MongoDB locally or set MONGO_URI in backend/.env, then restart.'
    );
  }

  mongoose.connection.on('disconnected', () => {
    console.warn('[db] MongoDB connection lost.');
  });

  mongoose.connection.on('error', (err) => {
    console.error(`[db] MongoDB connection error: ${err.message}`);
  });
}

function redactUri(uri) {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

module.exports = connectDB;

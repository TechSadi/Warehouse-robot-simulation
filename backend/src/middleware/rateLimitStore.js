const mongoose = require('mongoose');

/**
 * A shared, durable store for `express-rate-limit`.
 *
 * The default memory store keeps counters in the process, so limits are
 * not shared across instances and reset on every restart and redeploy.
 * That was accurate-but-fragile on a single free-tier instance and simply
 * wrong the moment there are two: an attacker gets one full budget per
 * instance, and any deploy hands out fresh budgets to everyone.
 *
 * Mongo rather than Redis because this application already has Mongo and
 * does not already have Redis, and a rate limiter is not worth an extra
 * piece of infrastructure to run, monitor and pay for. The trade is
 * honest: this costs a round trip per limited request, where Redis would
 * cost less. At the request volumes this API sees - and against the
 * alternative of limits that silently do not hold - that is the right way
 * round.
 *
 * The counter document is one atomic upsert-and-increment per request. The
 * window is stored as an absolute `expiresAt` rather than a start time, so
 * a window that has lapsed is replaced rather than extended, and a TTL
 * index sweeps up whatever nobody comes back to.
 */

const counterSchema = new mongoose.Schema(
  {
    // `<limiter prefix>:<key>` - see keyFor below. Unique, because the
    // whole mechanism is one document per key per window.
    key: { type: String, required: true, unique: true },
    count: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

counterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const RateLimitCounter =
  mongoose.models.RateLimitCounter || mongoose.model('RateLimitCounter', counterSchema);

/**
 * @implements {import('express-rate-limit').Store}
 */
class MongoRateLimitStore {
  constructor({ prefix = 'rl' } = {}) {
    this.prefix = prefix;
    this.windowMs = 60_000;
  }

  /** express-rate-limit hands the store its options once at startup. */
  init(options) {
    this.windowMs = options.windowMs;
  }

  keyFor(key) {
    return `${this.prefix}:${key}`;
  }

  /**
   * Increments and returns the current state.
   *
   * Two updates rather than one, and the order matters. A single upsert
   * cannot both "reset if the window lapsed" and "increment if it has
   * not", because `$set` and `$inc` on the same field conflict. So: first
   * try to increment a *live* window; if nothing matched, the window has
   * lapsed (or never existed) and a new one is started. The second write
   * is an upsert on a unique key, so two requests racing to start the same
   * window produce one document and one duplicate-key error, which is
   * retried into the increment path.
   */
  async increment(key) {
    const _id = this.keyFor(key);
    const now = new Date();

    const live = await RateLimitCounter.findOneAndUpdate(
      { key: _id, expiresAt: { $gt: now } },
      { $inc: { count: 1 } },
      { new: true }
    );
    if (live) return { totalHits: live.count, resetTime: live.expiresAt };

    const expiresAt = new Date(now.getTime() + this.windowMs);
    try {
      const started = await RateLimitCounter.findOneAndUpdate(
        { key: _id },
        { $set: { count: 1, expiresAt } },
        { upsert: true, new: true }
      );
      return { totalHits: started.count, resetTime: started.expiresAt };
    } catch (err) {
      if (err?.code === 11000) {
        // Lost the race to start the window; join the one that won.
        const joined = await RateLimitCounter.findOneAndUpdate(
          { key: _id },
          { $inc: { count: 1 } },
          { new: true }
        );
        if (joined) return { totalHits: joined.count, resetTime: joined.expiresAt };
      }
      throw err;
    }
  }

  /** Used by `skipSuccessfulRequests` / `skipFailedRequests` to give a hit
   * back after the fact. Floored at zero so a refund for a window that has
   * since rolled over cannot drive a fresh counter negative. */
  async decrement(key) {
    await RateLimitCounter.updateOne(
      { key: this.keyFor(key), count: { $gt: 0 } },
      { $inc: { count: -1 } }
    );
  }

  async resetKey(key) {
    await RateLimitCounter.deleteOne({ key: this.keyFor(key) });
  }

  async resetAll() {
    await RateLimitCounter.deleteMany({ key: new RegExp(`^${this.prefix}:`) });
  }
}

module.exports = { MongoRateLimitStore, RateLimitCounter };

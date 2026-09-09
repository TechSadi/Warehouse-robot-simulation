/**
 * Per-socket, per-event rate limiting.
 *
 * express-rate-limit only sees HTTP requests. A Socket.IO connection can
 * emit thousands of events per second over one already-established
 * connection, entirely bypassing it - which matters most for the events
 * that do real work: starting a tick loop, generating orders, dispatching,
 * or joining rooms in a loop to probe which warehouse ids exist.
 *
 * A token bucket rather than a fixed window: it absorbs the short bursts a
 * legitimate UI produces (a user clicking start/stop a few times, or a
 * panel re-joining rooms on reconnect) while still bounding the sustained
 * rate. State lives on the socket, so it is discarded with the connection
 * and cannot grow unboundedly across reconnects.
 */
class TokenBucket {
  constructor(capacity, refillPerSecond) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  tryConsume(cost = 1) {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
      this.lastRefill = now;
    }

    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/**
 * Budgets per event, chosen from what the event actually costs the server.
 * `simulation:tick` is the tightest: each one runs a full engine step,
 * persists every changed robot, and runs the dispatcher.
 */
const EVENT_LIMITS = {
  'warehouse:join': { capacity: 20, refillPerSecond: 1 },
  'warehouse:leave': { capacity: 20, refillPerSecond: 1 },
  'simulation:start': { capacity: 10, refillPerSecond: 0.5 },
  'simulation:stop': { capacity: 10, refillPerSecond: 0.5 },
  'simulation:tick': { capacity: 10, refillPerSecond: 2 },
  // Resynchronisation after a reconnect. Cheap (one engine read), but a
  // client that loops it is still asking the server to serialise a full
  // fleet snapshot each time.
  'simulation:sync': { capacity: 10, refillPerSecond: 1 },
  'orders:generate': { capacity: 5, refillPerSecond: 0.2 },
  'orders:dispatch': { capacity: 10, refillPerSecond: 0.5 },
  // Anything not named above shares one modest default budget, so a new
  // event added later is rate-limited from the moment it exists rather
  // than from the moment someone remembers to add it here.
  default: { capacity: 30, refillPerSecond: 5 },
};

/** Returns a `limit(eventName)` bound to one socket. */
function createSocketLimiter(socket) {
  const buckets = new Map();

  return function limit(eventName) {
    if (!buckets.has(eventName)) {
      const config = EVENT_LIMITS[eventName] || EVENT_LIMITS.default;
      buckets.set(eventName, new TokenBucket(config.capacity, config.refillPerSecond));
    }

    const allowed = buckets.get(eventName).tryConsume();
    if (!allowed) {
      socket.emit('error:rate_limit', {
        event: eventName,
        message: 'Rate limit exceeded for this event. Please slow down.',
      });
    }
    return allowed;
  };
}

module.exports = { createSocketLimiter, TokenBucket, EVENT_LIMITS };

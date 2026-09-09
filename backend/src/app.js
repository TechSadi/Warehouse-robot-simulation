const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');

const env = require('./config/env');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { mongoSanitize } = require('./middleware/dto');
const csrfProtection = require('./middleware/csrf');
const { apiLimiter } = require('./middleware/rateLimit');

const app = express();

// Render, Railway, and most PaaS platforms sit the app behind a reverse
// proxy - without this, req.ip (and Morgan's :remote-addr in the
// production log format below) would show the proxy's address for every
// request instead of the real client's. `1` trusts exactly one hop, which
// matches a single reverse proxy in front of the app; it's scoped to
// production since local dev has no proxy to account for.
//
// This is also load-bearing for security now, not just for logs: the rate
// limiters key unauthenticated traffic by req.ip. Trusting *every* proxy
// hop (`true`) would let a client set X-Forwarded-For itself and rotate
// its own rate-limit key at will, so the hop count stays exact.
if (env.isProduction) app.set('trust proxy', 1);

// Don't advertise the framework - one less trivially-automated way to
// fingerprint what to throw exploits at.
app.disable('x-powered-by');

// --- Security & performance middleware -------------------------------------------------
app.use(
  helmet({
    // This is a JSON API: it serves no HTML, so the correct CSP is one
    // that forbids essentially everything. It matters for the error and
    // 404 responses a browser might render directly.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    // The frontend is a separate origin loading data via fetch;
    // same-origin would block those legitimate cross-origin reads.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    // Tell browsers to stay on HTTPS for this host. Only meaningful in
    // production, where TLS actually terminates in front of us.
    hsts: env.isProduction
      ? { maxAge: 15552000, includeSubDomains: true, preload: false }
      : false,
  })
);

/**
 * CORS.
 *
 * `origin` is an explicit allow-list from CLIENT_ORIGINS, never `true` and
 * never `*`. With `credentials: true`, a reflected-origin policy is
 * equivalent to letting *any* website make authenticated requests on a
 * signed-in user's behalf and read the replies - the browser's SOP is the
 * only thing standing between a cookie-authenticated API and every page
 * the user has open. (The spec forbids `*` together with credentials
 * outright, but reflecting `req.headers.origin` recreates the same hole
 * while looking specific.)
 */
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header at all: curl, a health check, a same-origin
      // request. There is no browser to protect in that case, and CORS is
      // not an authentication mechanism - requireAuth still applies.
      if (!origin) return callback(null, true);
      if (env.clientOrigins.includes(origin)) return callback(null, true);
      return callback(null, false); // no CORS headers -> the browser blocks it
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
    maxAge: 600,
  })
);
app.use(compression());

// --- Request logging --------------------------------------------------------------------
app.use(morgan(env.isProduction ? 'combined' : 'dev'));

// --- Body parsing ------------------------------------------------------------------------
// A hard size cap: without one, express.json() will happily buffer a
// multi-megabyte body per request, which is a cheap memory-exhaustion
// lever. 256kb comfortably fits the largest legitimate payload here (an
// 80x80 warehouse layout).
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());

// Strips `$`-prefixed and dotted keys from body/query/params before
// anything builds a Mongo filter out of them. `{"email": {"$gt": ""}}` is
// valid JSON and, unsanitised, matches the first user in the collection.
app.use(mongoSanitize);

// --- Routes ------------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ success: true, message: 'Warehouse Robot Simulation API' });
});

// Baseline limit for every API route. Per-route limiters (auth,
// pathfinding, trace, dispatch, ...) stack on top of this one; this is
// sized so a running simulation never hits it - see rateLimit.js.
app.use('/api', apiLimiter);

// Double-submit CSRF on every state-changing API request. Registered
// before the routers so a new route cannot forget it. Requests
// authenticated by an Authorization header instead of a cookie are exempt
// (there is no ambient credential to abuse) - see middleware/csrf.js.
app.use('/api', csrfProtection);

app.use('/api', routes);

// --- Error handling (must be last) --------------------------------------------------------
app.use(notFound);
app.use(errorHandler);

module.exports = app;

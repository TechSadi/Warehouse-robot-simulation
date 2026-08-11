const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const compression = require('compression');

const env = require('./config/env');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Render, Railway, and most PaaS platforms sit the app behind a reverse
// proxy - without this, req.ip (and Morgan's :remote-addr in the
// production log format below) would show the proxy's address for every
// request instead of the real client's. `1` trusts exactly one hop, which
// matches a single reverse proxy in front of the app; it's scoped to
// production since local dev has no proxy to account for.
if (env.isProduction) app.set('trust proxy', 1);

// --- Security & performance middleware -------------------------------------------------
app.use(helmet());
app.use(
  cors({
    origin: env.clientOrigins,
    credentials: true,
  })
);
app.use(compression());

// --- Request logging --------------------------------------------------------------------
app.use(morgan(env.isProduction ? 'combined' : 'dev'));

// --- Body parsing ------------------------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Routes ------------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ success: true, message: 'Warehouse Robot Simulation API' });
});

app.use('/api', routes);

// --- Error handling (must be last) --------------------------------------------------------
app.use(notFound);
app.use(errorHandler);

module.exports = app;

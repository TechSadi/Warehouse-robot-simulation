const { Router } = require('express');
const healthRoutes = require('./health.routes');
const authRoutes = require('./auth.routes');
const warehouseRoutes = require('./warehouse.routes');
const robotRoutes = require('./robot.routes');
const orderRoutes = require('./order.routes');
const statisticsRoutes = require('./statistics.routes');
const logRoutes = require('./log.routes');
const adminRoutes = require('./admin.routes');
const telemetryRoutes = require('./telemetry.routes');

const router = Router();

// /health and /auth are the only unauthenticated surfaces. Every other
// router below calls `router.use(requireAuth)` at its top, so a new route
// added to any of them is authenticated by default rather than by
// remembering to opt in - the failure mode of a per-route opt-in is a
// forgotten line, and that failure mode is an open endpoint.
router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/warehouses', warehouseRoutes);
router.use('/robots', robotRoutes);
router.use('/orders', orderRoutes);
router.use('/statistics', statisticsRoutes);
router.use('/logs', logRoutes);
// Both gate themselves at the top of their own router, same as every
// router above: /admin additionally requires the `admin` role, and
// /telemetry is where the dashboard reports its own render failures.
router.use('/admin', adminRoutes);
router.use('/telemetry', telemetryRoutes);

module.exports = router;

const { Router } = require('express');
const healthRoutes = require('./health.routes');
const warehouseRoutes = require('./warehouse.routes');
const robotRoutes = require('./robot.routes');
const orderRoutes = require('./order.routes');
const statisticsRoutes = require('./statistics.routes');
const logRoutes = require('./log.routes');

const router = Router();

router.use('/health', healthRoutes);
router.use('/warehouses', warehouseRoutes);
router.use('/robots', robotRoutes);
router.use('/orders', orderRoutes);
router.use('/statistics', statisticsRoutes);
router.use('/logs', logRoutes);

module.exports = router;

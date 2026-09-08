const { Router } = require('express');
const { body, param, query } = require('express-validator');
const Statistics = require('../models/Statistics');
const controller = require('../controllers/statistics.controller');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const {
  requireOwnedResource,
  requireWarehouseBody,
  scopeListToOwner,
} = require('../middleware/authorize');
const { writeLimiter } = require('../middleware/rateLimit');

const router = Router();

router.use(requireAuth);

const idParam = param('id').isMongoId().withMessage('id must be a valid Mongo ObjectId');
const ownedSnapshot = () => requireOwnedResource(Statistics, 'Statistics snapshot');

router.get(
  '/',
  [
    query('warehouseId').optional().isMongoId(),
    query('from').optional().isISO8601().withMessage('from must be an ISO 8601 date'),
    query('to').optional().isISO8601().withMessage('to must be an ISO 8601 date'),
  ],
  validate,
  scopeListToOwner(),
  controller.list
);

router.get('/:id', [idParam], validate, ownedSnapshot(), controller.getOne);

// `recordedAt` is deliberately not accepted - see the DTO comment in
// statistics.controller.js. Every metric is bounded: an unbounded
// `deliveriesPerHour` is a number that ends up on a chart axis.
router.post(
  '/',
  writeLimiter,
  [
    body('warehouseId').isMongoId().withMessage('warehouseId must be a valid Mongo ObjectId'),
    body('metrics.activeRobots').optional().isInt({ min: 0, max: 100000 }),
    body('metrics.idleRobots').optional().isInt({ min: 0, max: 100000 }),
    body('metrics.pendingOrders').optional().isInt({ min: 0, max: 1000000 }),
    body('metrics.completedOrders').optional().isInt({ min: 0, max: 1000000 }),
    body('metrics.avgBattery').optional().isFloat({ min: 0, max: 100 }),
    body('metrics.deliveriesPerHour').optional().isFloat({ min: 0, max: 1000000 }),
  ],
  validate,
  requireWarehouseBody(),
  controller.create
);

router.delete('/:id', [idParam], validate, ownedSnapshot(), controller.remove);

module.exports = router;

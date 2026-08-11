const { Router } = require('express');
const { body, param, query } = require('express-validator');
const controller = require('../controllers/statistics.controller');
const validate = require('../middleware/validate');

const router = Router();

const idParam = param('id').isMongoId().withMessage('id must be a valid Mongo ObjectId');

router.get(
  '/',
  [
    query('warehouseId').optional().isMongoId(),
    query('from').optional().isISO8601().withMessage('from must be an ISO 8601 date'),
    query('to').optional().isISO8601().withMessage('to must be an ISO 8601 date'),
  ],
  validate,
  controller.list
);

router.get('/:id', [idParam], validate, controller.getOne);

router.post(
  '/',
  [
    body('warehouseId').isMongoId().withMessage('warehouseId must be a valid Mongo ObjectId'),
    body('recordedAt').optional().isISO8601(),
    body('metrics.activeRobots').optional().isInt({ min: 0 }),
    body('metrics.idleRobots').optional().isInt({ min: 0 }),
    body('metrics.pendingOrders').optional().isInt({ min: 0 }),
    body('metrics.completedOrders').optional().isInt({ min: 0 }),
    body('metrics.avgBattery').optional().isFloat({ min: 0, max: 100 }),
    body('metrics.deliveriesPerHour').optional().isFloat({ min: 0 }),
  ],
  validate,
  controller.create
);

router.delete('/:id', [idParam], validate, controller.remove);

module.exports = router;

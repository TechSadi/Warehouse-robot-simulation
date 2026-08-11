const { Router } = require('express');
const { body, param, query } = require('express-validator');
const controller = require('../controllers/robot.controller');
const validate = require('../middleware/validate');
const { STATUSES } = require('../models/Robot');

const router = Router();

const idParam = param('id').isMongoId().withMessage('id must be a valid Mongo ObjectId');

router.get(
  '/',
  [
    query('warehouseId').optional().isMongoId().withMessage('warehouseId must be a valid Mongo ObjectId'),
    query('status').optional().isIn(STATUSES).withMessage(`status must be one of: ${STATUSES.join(', ')}`),
  ],
  validate,
  controller.list
);

router.get('/:id', [idParam], validate, controller.getOne);

router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('name is required').isLength({ max: 60 }),
    body('warehouseId').isMongoId().withMessage('warehouseId must be a valid Mongo ObjectId'),
    body('position.x').optional().isFloat({ min: 0 }),
    body('position.y').optional().isFloat({ min: 0 }),
    body('rotation').optional().isFloat({ min: 0, max: 360 }),
    body('speed').optional().isFloat({ min: 0 }),
    body('battery').optional().isFloat({ min: 0, max: 100 }),
    body('status').optional().isIn(STATUSES).withMessage(`status must be one of: ${STATUSES.join(', ')}`),
  ],
  validate,
  controller.create
);

router.put(
  '/:id',
  [
    idParam,
    body('name').optional().trim().notEmpty().isLength({ max: 60 }),
    body('warehouseId').optional().isMongoId(),
    body('position.x').optional().isFloat({ min: 0 }),
    body('position.y').optional().isFloat({ min: 0 }),
    body('rotation').optional().isFloat({ min: 0, max: 360 }),
    body('speed').optional().isFloat({ min: 0 }),
    body('battery').optional().isFloat({ min: 0, max: 100 }),
    body('status').optional().isIn(STATUSES).withMessage(`status must be one of: ${STATUSES.join(', ')}`),
  ],
  validate,
  controller.update
);

router.delete('/:id', [idParam], validate, controller.remove);

router.post(
  '/:id/tasks',
  [
    idParam,
    body('destination.x').isFloat({ min: 0 }).withMessage('destination.x must be a non-negative number'),
    body('destination.y').isFloat({ min: 0 }).withMessage('destination.y must be a non-negative number'),
  ],
  validate,
  controller.assignTask
);

router.post('/:id/charge', [idParam], validate, controller.startCharging);

router.post('/:id/clear-error', [idParam], validate, controller.clearError);

router.post(
  '/:id/break',
  [idParam, body('reason').optional().trim().isLength({ max: 200 })],
  validate,
  controller.markBroken
);

module.exports = router;

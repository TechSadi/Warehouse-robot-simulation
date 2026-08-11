const { Router } = require('express');
const { body, param, query } = require('express-validator');
const controller = require('../controllers/order.controller');
const validate = require('../middleware/validate');
const { STATUSES, PRIORITIES } = require('../models/Order');

const router = Router();

const idParam = param('id').isMongoId().withMessage('id must be a valid Mongo ObjectId');

const locationBody = (field) => [
  body(`${field}.x`).isFloat({ min: 0 }).withMessage(`${field}.x must be a non-negative number`),
  body(`${field}.y`).isFloat({ min: 0 }).withMessage(`${field}.y must be a non-negative number`),
];

router.get(
  '/',
  [
    query('warehouseId').optional().isMongoId(),
    query('status').optional().isIn(STATUSES).withMessage(`status must be one of: ${STATUSES.join(', ')}`),
    query('priority').optional().isIn(PRIORITIES).withMessage(`priority must be one of: ${PRIORITIES.join(', ')}`),
  ],
  validate,
  controller.list
);

router.get('/:id', [idParam], validate, controller.getOne);

router.post(
  '/',
  [
    body('warehouseId').isMongoId().withMessage('warehouseId must be a valid Mongo ObjectId'),
    ...locationBody('pickupLocation'),
    ...locationBody('deliveryLocation'),
    body('priority').optional().isIn(PRIORITIES).withMessage(`priority must be one of: ${PRIORITIES.join(', ')}`),
    body('status').optional().isIn(STATUSES).withMessage(`status must be one of: ${STATUSES.join(', ')}`),
  ],
  validate,
  controller.create
);

router.put(
  '/:id',
  [
    idParam,
    body('pickupLocation.x').optional().isFloat({ min: 0 }),
    body('pickupLocation.y').optional().isFloat({ min: 0 }),
    body('deliveryLocation.x').optional().isFloat({ min: 0 }),
    body('deliveryLocation.y').optional().isFloat({ min: 0 }),
    body('priority').optional().isIn(PRIORITIES).withMessage(`priority must be one of: ${PRIORITIES.join(', ')}`),
    body('status').optional().isIn(STATUSES).withMessage(`status must be one of: ${STATUSES.join(', ')}`),
    body('assignedRobot').optional({ nullable: true }).isMongoId(),
  ],
  validate,
  controller.update
);

router.delete('/:id', [idParam], validate, controller.remove);

module.exports = router;

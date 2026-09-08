const { Router } = require('express');
const { body, param, query } = require('express-validator');
const Order = require('../models/Order');
const controller = require('../controllers/order.controller');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const {
  requireOwnedResource,
  requireWarehouseBody,
  scopeListToOwner,
} = require('../middleware/authorize');
const { writeLimiter } = require('../middleware/rateLimit');
const { PRIORITIES } = require('../models/Order');
const { STATUSES } = require('../domain/orderLifecycle');

const router = Router();

router.use(requireAuth);

const idParam = param('id').isMongoId().withMessage('id must be a valid Mongo ObjectId');
const ownedOrder = () => requireOwnedResource(Order, 'Order');

const locationBody = (field) => [
  body(`${field}.x`).isFloat({ min: 0, max: 79 }).withMessage(`${field}.x must be between 0 and 79`),
  body(`${field}.y`).isFloat({ min: 0, max: 79 }).withMessage(`${field}.y must be between 0 and 79`),
];

router.get(
  '/',
  [
    query('warehouseId').optional().isMongoId(),
    query('status').optional().isIn(STATUSES).withMessage(`status must be one of: ${STATUSES.join(', ')}`),
    query('priority').optional().isIn(PRIORITIES).withMessage(`priority must be one of: ${PRIORITIES.join(', ')}`),
  ],
  validate,
  scopeListToOwner(),
  controller.list
);

router.get('/:id', [idParam], validate, ownedOrder(), controller.getOne);

// `status` is not accepted on create: an order starts pending, always.
// See the DTO comment in order.controller.js.
router.post(
  '/',
  writeLimiter,
  [
    body('warehouseId').isMongoId().withMessage('warehouseId must be a valid Mongo ObjectId'),
    ...locationBody('pickupLocation'),
    ...locationBody('deliveryLocation'),
    body('priority').optional().isIn(PRIORITIES).withMessage(`priority must be one of: ${PRIORITIES.join(', ')}`),
  ],
  validate,
  requireWarehouseBody(),
  controller.create
);

// A `status` here is checked against the lifecycle state machine
// (domain/orderLifecycle.js), not merely against the schema enum - passing
// this validator only means the value is a real status, not that the move
// to it is legal from where the order currently is.
router.put(
  '/:id',
  writeLimiter,
  [
    idParam,
    body('pickupLocation.x').optional().isFloat({ min: 0, max: 79 }),
    body('pickupLocation.y').optional().isFloat({ min: 0, max: 79 }),
    body('deliveryLocation.x').optional().isFloat({ min: 0, max: 79 }),
    body('deliveryLocation.y').optional().isFloat({ min: 0, max: 79 }),
    body('priority').optional().isIn(PRIORITIES).withMessage(`priority must be one of: ${PRIORITIES.join(', ')}`),
    body('status').optional().isIn(STATUSES).withMessage(`status must be one of: ${STATUSES.join(', ')}`),
    body('assignedRobot').optional({ nullable: true }).isMongoId(),
  ],
  validate,
  ownedOrder(),
  controller.update
);

router.delete('/:id', [idParam], validate, ownedOrder(), controller.remove);

module.exports = router;

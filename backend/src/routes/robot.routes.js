const { Router } = require('express');
const { body, param, query } = require('express-validator');
const Robot = require('../models/Robot');
const controller = require('../controllers/robot.controller');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const {
  requireOwnedResource,
  requireWarehouseBody,
  scopeListToOwner,
} = require('../middleware/authorize');
const { writeLimiter } = require('../middleware/rateLimit');
const { STATUSES } = require('../models/Robot');

const router = Router();

router.use(requireAuth);

const idParam = param('id').isMongoId().withMessage('id must be a valid Mongo ObjectId');
// Resolves :id to a robot the caller's warehouse actually contains, or
// 404s. Every single-robot route below goes through it, so no handler ever
// sees an id it has not had authorized.
const ownedRobot = () => requireOwnedResource(Robot, 'Robot');

router.get(
  '/',
  [
    query('warehouseId').optional().isMongoId().withMessage('warehouseId must be a valid Mongo ObjectId'),
    query('status').optional().isIn(STATUSES).withMessage(`status must be one of: ${STATUSES.join(', ')}`),
  ],
  validate,
  scopeListToOwner(),
  controller.list
);

router.get('/:id', [idParam], validate, ownedRobot(), controller.getOne);

router.post(
  '/',
  writeLimiter,
  [
    body('name').trim().notEmpty().withMessage('name is required').isLength({ max: 60 }),
    body('warehouseId').isMongoId().withMessage('warehouseId must be a valid Mongo ObjectId'),
    body('position.x').optional().isFloat({ min: 0, max: 79 }),
    body('position.y').optional().isFloat({ min: 0, max: 79 }),
    body('speed').optional().isFloat({ min: 0, max: 20 }),
    body('battery').optional().isFloat({ min: 0, max: 100 }),
  ],
  validate,
  requireWarehouseBody(),
  controller.create
);

// `status`, `battery`, `position`, `rotation` are intentionally not
// accepted here - see the DTO comment in robot.controller.js. Attempting
// one is a 422 pointing at the endpoint that owns that transition, rather
// than a silently ignored field.
router.put(
  '/:id',
  writeLimiter,
  [
    idParam,
    body('name').optional().trim().notEmpty().isLength({ max: 60 }),
    body('speed').optional().isFloat({ min: 0, max: 20 }),
  ],
  validate,
  ownedRobot(),
  controller.update
);

router.delete('/:id', [idParam], validate, ownedRobot(), controller.remove);

router.post(
  '/:id/tasks',
  writeLimiter,
  [
    idParam,
    body('destination.x').isFloat({ min: 0, max: 79 }).withMessage('destination.x must be between 0 and 79'),
    body('destination.y').isFloat({ min: 0, max: 79 }).withMessage('destination.y must be between 0 and 79'),
  ],
  validate,
  ownedRobot(),
  controller.assignTask
);

router.post('/:id/charge', writeLimiter, [idParam], validate, ownedRobot(), controller.startCharging);

router.post('/:id/clear-error', writeLimiter, [idParam], validate, ownedRobot(), controller.clearError);

router.post(
  '/:id/break',
  writeLimiter,
  [idParam, body('reason').optional().isString().trim().isLength({ max: 200 })],
  validate,
  ownedRobot(),
  controller.markBroken
);

module.exports = router;

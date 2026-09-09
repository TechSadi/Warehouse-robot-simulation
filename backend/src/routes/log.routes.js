const { Router } = require('express');
const { body, param, query } = require('express-validator');
const Log = require('../models/Log');
const controller = require('../controllers/log.controller');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const {
  requireOwnedResource,
  requireWarehouseBody,
  scopeListToOwner,
} = require('../middleware/authorize');
const { writeLimiter } = require('../middleware/rateLimit');
const { LEVELS } = require('../models/Log');

const router = Router();

router.use(requireAuth);

const idParam = param('id').isMongoId().withMessage('id must be a valid Mongo ObjectId');
const ownedLog = () => requireOwnedResource(Log, 'Log entry');

router.get(
  '/',
  [
    query('warehouseId').optional().isMongoId(),
    query('level').optional().isIn(LEVELS).withMessage(`level must be one of: ${LEVELS.join(', ')}`),
    // `source` reaches a Mongo filter, so it is constrained to a short
    // plain string rather than left as "any value express-validator will
    // accept" - which included objects.
    query('source').optional().isString().trim().isLength({ max: 60 }),
  ],
  validate,
  scopeListToOwner(),
  controller.list
);

router.get('/:id', [idParam], validate, ownedLog(), controller.getOne);

// `source` and `meta` are not accepted from clients - see the DTO comment
// in log.controller.js. `warehouseId` is now required rather than
// optional: a log with no warehouse is a system record, and system records
// are written by the server.
router.post(
  '/',
  writeLimiter,
  [
    body('message').trim().notEmpty().withMessage('message is required').isLength({ max: 500 }),
    body('level').optional().isIn(LEVELS).withMessage(`level must be one of: ${LEVELS.join(', ')}`),
    body('warehouseId').isMongoId().withMessage('warehouseId must be a valid Mongo ObjectId'),
  ],
  validate,
  requireWarehouseBody(),
  controller.create
);

router.delete('/:id', [idParam], validate, ownedLog(), controller.remove);

module.exports = router;

const { Router } = require('express');
const { body, param, query } = require('express-validator');
const controller = require('../controllers/warehouse.controller');
const validate = require('../middleware/validate');
const { requireAuth } = require('../middleware/auth');
const { requireWarehouseParam, ACCESS } = require('../middleware/authorize');
const {
  writeLimiter,
  pathfindingLimiter,
  traceLimiter,
  orderGenerationLimiter,
  dispatchLimiter,
  tickLimiter,
} = require('../middleware/rateLimit');
const { CELL_TYPES } = require('../models/Warehouse');
const { EMAIL_PATTERN } = require('../models/User');
const { STRATEGY_KEYS } = require('../engine/scheduling/strategies');
const { OBSTACLE_TYPES } = require('../engine/obstacles/dynamicObstacles');

const router = Router();

// Every warehouse route requires a signed-in caller, and every route with
// an `:id` additionally requires that caller to *reach* that warehouse far
// enough for what they are asking (requireWarehouseParam). Authentication
// alone would still let any signed-in user read and drive every other
// user's simulation by guessing ids.
//
// The level is named at each route rather than inferred from the HTTP
// verb, because the verb is the wrong signal here: `POST /:id/tick` is a
// write in every sense that matters, and `PUT /:id` (which can change the
// layout, reloading the engine and requeueing in-flight orders) is a
// different kind of act from `POST /:id/orders/generate`. Three levels,
// defined in middleware/authorize.js:
//
//   VIEW  read it, watch it run
//   EDIT  change what is in it - robots, orders, obstacles, ticking
//   OWN   change whether it exists, what shape it is, and who can reach it
router.use(requireAuth);

const idParam = param('id').isMongoId().withMessage('id must be a valid Mongo ObjectId');

// A layout is bounded at 80x80 = 6400 cells; anything beyond that is not a
// warehouse, it is a way to make the server serialise an arbitrarily large
// document on every read.
const MAX_CELLS = 6400;

const cellBody = body('cells')
  .optional()
  .isArray({ max: MAX_CELLS })
  .withMessage(`cells must be an array of at most ${MAX_CELLS} entries`);
const cellItemBody = body('cells.*.x').optional().isInt({ min: 0, max: 79 }).withMessage('cell.x must be an integer between 0 and 79');
const cellItemYBody = body('cells.*.y').optional().isInt({ min: 0, max: 79 }).withMessage('cell.y must be an integer between 0 and 79');
const cellItemTypeBody = body('cells.*.type')
  .optional()
  .isIn(CELL_TYPES)
  .withMessage(`cell.type must be one of: ${CELL_TYPES.join(', ')}`);

router.get(
  '/',
  [query('isActive').optional().isBoolean().withMessage('isActive must be true or false')],
  validate,
  controller.list
);

router.get('/:id', [idParam], validate, requireWarehouseParam('id', { access: ACCESS.VIEW }), controller.getOne);

router.post(
  '/',
  writeLimiter,
  [
    body('name').trim().notEmpty().withMessage('name is required').isLength({ max: 80 }),
    body('rows').isInt({ min: 5, max: 80 }).withMessage('rows must be an integer between 5 and 80'),
    body('cols').isInt({ min: 5, max: 80 }).withMessage('cols must be an integer between 5 and 80'),
    cellBody,
    cellItemBody,
    cellItemYBody,
    cellItemTypeBody,
    body('schedulingStrategy')
      .optional()
      .isIn(STRATEGY_KEYS)
      .withMessage(`schedulingStrategy must be one of: ${STRATEGY_KEYS.join(', ')}`),
  ],
  validate,
  controller.create
);

router.put(
  '/:id',
  writeLimiter,
  [
    idParam,
    body('name').optional().trim().notEmpty().isLength({ max: 80 }),
    body('rows').optional().isInt({ min: 5, max: 80 }),
    body('cols').optional().isInt({ min: 5, max: 80 }),
    cellBody,
    cellItemBody,
    cellItemYBody,
    cellItemTypeBody,
    body('schedulingStrategy')
      .optional()
      .isIn(STRATEGY_KEYS)
      .withMessage(`schedulingStrategy must be one of: ${STRATEGY_KEYS.join(', ')}`),
  ],
  validate,
  // OWN: this route can change `rows`/`cols`/`cells`, which invalidates
  // the live engine and requeues every in-flight order. Reshaping the
  // building is not something a collaborator does to it.
  requireWarehouseParam('id', { access: ACCESS.OWN }),
  controller.update
);

router.delete('/:id', [idParam], validate, requireWarehouseParam('id', { access: ACCESS.OWN }), controller.remove);

// Activation deactivates the caller's *other* warehouses, so it is a
// statement about their own account rather than about this warehouse.
router.patch(
  '/:id/activate',
  [idParam],
  validate,
  requireWarehouseParam('id', { access: ACCESS.OWN }),
  controller.activate
);

router.post(
  '/:id/path',
  pathfindingLimiter,
  traceLimiter, // only charged for trace:true requests - see rateLimit.js
  [
    idParam,
    // Bounded rather than merely non-negative: the controller additionally
    // checks the point against this warehouse's actual dimensions.
    body('start.x').isFloat({ min: 0, max: 79 }).withMessage('start.x must be between 0 and 79'),
    body('start.y').isFloat({ min: 0, max: 79 }).withMessage('start.y must be between 0 and 79'),
    body('goal.x').isFloat({ min: 0, max: 79 }).withMessage('goal.x must be between 0 and 79'),
    body('goal.y').isFloat({ min: 0, max: 79 }).withMessage('goal.y must be between 0 and 79'),
    body('heuristic').optional().isIn(['manhattan', 'euclidean', 'diagonal']),
    body('allowDiagonal').optional().isBoolean(),
    body('trace').optional().isBoolean().withMessage('trace must be true or false'),
  ],
  validate,
  requireWarehouseParam('id', { access: ACCESS.VIEW }),
  controller.findRoute
);

router.post(
  '/:id/tick',
  tickLimiter,
  [idParam, body('deltaSeconds').optional().isFloat({ min: 0, max: 10 })],
  validate,
  requireWarehouseParam(),
  controller.tick
);

router.post(
  '/:id/orders/generate',
  orderGenerationLimiter,
  [idParam, body('count').optional().isInt({ min: 1, max: 100 }).withMessage('count must be between 1 and 100')],
  validate,
  requireWarehouseParam(),
  controller.generateOrders
);

router.post(
  '/:id/orders/dispatch',
  dispatchLimiter,
  [idParam],
  validate,
  requireWarehouseParam(),
  controller.dispatchOrders
);

router.get(
  '/:id/obstacles',
  [idParam],
  validate,
  requireWarehouseParam('id', { access: ACCESS.VIEW }),
  controller.listObstacles
);

router.post(
  '/:id/obstacles',
  writeLimiter,
  [
    idParam,
    body('id').trim().notEmpty().withMessage('id is required').isLength({ max: 80 }),
    body('type').isIn(OBSTACLE_TYPES).withMessage(`type must be one of: ${OBSTACLE_TYPES.join(', ')}`),
    body('cells')
      .isArray({ min: 1, max: 400 })
      .withMessage('cells must be a non-empty array of at most 400 entries'),
    body('cells.*.x').isInt({ min: 0, max: 79 }).withMessage('cells[].x must be an integer between 0 and 79'),
    body('cells.*.y').isInt({ min: 0, max: 79 }).withMessage('cells[].y must be an integer between 0 and 79'),
    body('durationSeconds').optional({ nullable: true }).isFloat({ min: 0, max: 86400 }),
  ],
  validate,
  requireWarehouseParam(),
  controller.addObstacle
);

router.delete(
  '/:id/obstacles/:obstacleId',
  [idParam, param('obstacleId').isString().trim().notEmpty().isLength({ max: 80 })],
  validate,
  requireWarehouseParam(),
  controller.removeObstacle
);

// --- Sharing -----------------------------------------------------------
//
// All three require OWN. An editor can change everything *in* a warehouse
// and nothing about who can reach it - otherwise the first person you
// shared with could share it onward, or remove you.

router.get(
  '/:id/collaborators',
  [idParam],
  validate,
  requireWarehouseParam('id', { access: ACCESS.OWN }),
  controller.listCollaborators
);

router.post(
  '/:id/collaborators',
  writeLimiter,
  [
    idParam,
    // By email, not by user id: an id is not something one person knows
    // about another, and an endpoint that resolved one would be an
    // enumeration oracle over the user table.
    body('email').isString().trim().toLowerCase().isLength({ max: 254 }).matches(EMAIL_PATTERN),
    body('role').optional().isIn(['viewer', 'editor']),
  ],
  validate,
  requireWarehouseParam('id', { access: ACCESS.OWN }),
  controller.addCollaborator
);

router.delete(
  '/:id/collaborators/:userId',
  [idParam, param('userId').isMongoId()],
  validate,
  requireWarehouseParam('id', { access: ACCESS.OWN }),
  controller.removeCollaborator
);

module.exports = router;

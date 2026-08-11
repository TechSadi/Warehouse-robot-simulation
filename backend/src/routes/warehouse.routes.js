const { Router } = require('express');
const { body, param, query } = require('express-validator');
const controller = require('../controllers/warehouse.controller');
const validate = require('../middleware/validate');
const { CELL_TYPES } = require('../models/Warehouse');
const { STRATEGY_KEYS } = require('../engine/scheduling/strategies');
const { OBSTACLE_TYPES } = require('../engine/obstacles/dynamicObstacles');

const router = Router();

const idParam = param('id').isMongoId().withMessage('id must be a valid Mongo ObjectId');

const cellBody = body('cells')
  .optional()
  .isArray()
  .withMessage('cells must be an array');
const cellItemBody = body('cells.*.x').optional().isInt({ min: 0 }).withMessage('cell.x must be a non-negative integer');
const cellItemYBody = body('cells.*.y').optional().isInt({ min: 0 }).withMessage('cell.y must be a non-negative integer');
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

router.get('/:id', [idParam], validate, controller.getOne);

router.post(
  '/',
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
  controller.update
);

router.delete('/:id', [idParam], validate, controller.remove);

router.patch('/:id/activate', [idParam], validate, controller.activate);

router.post(
  '/:id/path',
  [
    idParam,
    body('start.x').isFloat({ min: 0 }).withMessage('start.x must be a non-negative number'),
    body('start.y').isFloat({ min: 0 }).withMessage('start.y must be a non-negative number'),
    body('goal.x').isFloat({ min: 0 }).withMessage('goal.x must be a non-negative number'),
    body('goal.y').isFloat({ min: 0 }).withMessage('goal.y must be a non-negative number'),
    body('heuristic').optional().isIn(['manhattan', 'euclidean', 'diagonal']),
    body('allowDiagonal').optional().isBoolean(),
    body('trace').optional().isBoolean().withMessage('trace must be true or false'),
  ],
  validate,
  controller.findRoute
);

router.post(
  '/:id/tick',
  [idParam, body('deltaSeconds').optional().isFloat({ min: 0, max: 10 })],
  validate,
  controller.tick
);

router.post(
  '/:id/orders/generate',
  [idParam, body('count').optional().isInt({ min: 1, max: 100 }).withMessage('count must be between 1 and 100')],
  validate,
  controller.generateOrders
);

router.post('/:id/orders/dispatch', [idParam], validate, controller.dispatchOrders);

router.get('/:id/obstacles', [idParam], validate, controller.listObstacles);

router.post(
  '/:id/obstacles',
  [
    idParam,
    body('id').trim().notEmpty().withMessage('id is required'),
    body('type').isIn(OBSTACLE_TYPES).withMessage(`type must be one of: ${OBSTACLE_TYPES.join(', ')}`),
    body('cells').isArray({ min: 1 }).withMessage('cells must be a non-empty array'),
    body('cells.*.x').isInt({ min: 0 }).withMessage('cells[].x must be a non-negative integer'),
    body('cells.*.y').isInt({ min: 0 }).withMessage('cells[].y must be a non-negative integer'),
    body('durationSeconds').optional({ nullable: true }).isFloat({ min: 0 }),
  ],
  validate,
  controller.addObstacle
);

router.delete('/:id/obstacles/:obstacleId', [idParam], validate, controller.removeObstacle);

module.exports = router;

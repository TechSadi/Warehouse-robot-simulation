const { Router } = require('express');
const { body, param, query } = require('express-validator');
const controller = require('../controllers/log.controller');
const validate = require('../middleware/validate');
const { LEVELS } = require('../models/Log');

const router = Router();

const idParam = param('id').isMongoId().withMessage('id must be a valid Mongo ObjectId');

router.get(
  '/',
  [
    query('warehouseId').optional().isMongoId(),
    query('level').optional().isIn(LEVELS).withMessage(`level must be one of: ${LEVELS.join(', ')}`),
    query('source').optional().isString(),
  ],
  validate,
  controller.list
);

router.get('/:id', [idParam], validate, controller.getOne);

router.post(
  '/',
  [
    body('message').trim().notEmpty().withMessage('message is required').isLength({ max: 500 }),
    body('level').optional().isIn(LEVELS).withMessage(`level must be one of: ${LEVELS.join(', ')}`),
    body('source').optional().trim().isLength({ max: 60 }),
    body('warehouseId').optional({ nullable: true }).isMongoId(),
  ],
  validate,
  controller.create
);

router.delete('/:id', [idParam], validate, controller.remove);

module.exports = router;

const { validationResult } = require('express-validator');
const { ApiError } = require('./errorHandler');

function validate(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const details = result.array({ onlyFirstError: true }).map((e) => ({
    field: e.path,
    message: e.msg,
  }));
  next(new ApiError(400, 'Validation failed', details));
}

module.exports = validate;

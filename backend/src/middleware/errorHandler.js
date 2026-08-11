/**
 * Small typed error so controllers can `throw new ApiError(404, 'Robot not found')`
 * and have it formatted consistently by errorHandler below.
 */
class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

/** Catches requests that didn't match any route. */
function notFound(req, res, next) {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
}

const ROBOT_ENGINE_ERROR_STATUS = {
  ROBOT_NOT_FOUND: 404,
  DUPLICATE_ROBOT: 409,
  UNWALKABLE_POSITION: 400,
  INVALID_ARGUMENT: 400,
  INVALID_TRANSITION: 409,
  NOT_AT_CHARGING_STATION: 409,
};

/** Final error-formatting middleware. Must be registered last. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  let message = err.message || 'Internal Server Error';
  let details = err.details;

  // Mongoose throws its own error types for bad input; translate the
  // common ones into the same { message, details } shape as ApiError so
  // callers don't need to special-case where an error came from.
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid ${err.path}: "${err.value}"`;
  } else if (err.name === 'ValidationError') {
    statusCode = 400;
    message = 'Validation failed';
    details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
  } else if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0];
    message = field ? `A record with that ${field} already exists.` : 'Duplicate key error';
    details = err.keyValue;
  } else if (err.name === 'RobotEngineError' && ROBOT_ENGINE_ERROR_STATUS[err.code]) {
    statusCode = ROBOT_ENGINE_ERROR_STATUS[err.code];
    message = err.message;
  }

  const isProduction = process.env.NODE_ENV === 'production';

  if (statusCode >= 500) {
    console.error(err);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      ...(details ? { details } : {}),
      ...(isProduction ? {} : { stack: err.stack }),
    },
  });
}

module.exports = { ApiError, notFound, errorHandler };

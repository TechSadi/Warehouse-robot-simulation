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

/** Catches requests that didn't match any route. The path is echoed back
 * truncated and with the query string dropped - a 404 body is a reflection
 * point, and there is no reason for it to carry an arbitrary-length
 * attacker-chosen string (or the query parameters, which on this API can
 * contain ids). */
function notFound(req, res, next) {
  const path = String(req.path || '').slice(0, 120);
  next(new ApiError(404, `Route not found: ${req.method} ${path}`));
}

// Illegal domain state transitions (see src/domain/) - one mapping for
// both the order and robot state machines.
const DOMAIN_TRANSITION_ERRORS = new Set(['OrderTransitionError', 'RobotTransitionError']);

const JWT_ERRORS = new Set(['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError']);

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
  } else if (DOMAIN_TRANSITION_ERRORS.has(err.name)) {
    // An illegal state move is a conflict with the resource's current
    // state, not a malformed request - 409 rather than 400, and the same
    // code the simulation engine reports for its own bad transitions.
    statusCode = 409;
    message = err.message;
    details = { code: err.code, from: err.from, to: err.to };
  } else if (JWT_ERRORS.has(err.name)) {
    // Never surface jsonwebtoken's internals ("invalid signature",
    // "jwt malformed") - they tell an attacker how close a forged token
    // came, and they are of no use to a legitimate client.
    statusCode = 401;
    message = 'Not authenticated';
    details = undefined;
  }

  const isProduction = process.env.NODE_ENV === 'production';

  if (statusCode >= 500) {
    console.error(err);
    if (isProduction) {
      // A 500 message can carry a driver error, a query fragment, or a
      // file path. Log the real thing; tell the client nothing.
      message = 'Internal Server Error';
      details = undefined;
    }
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      ...(details ? { details } : {}),
      // Stack traces map the server's filesystem and dependency versions.
      // Development only, and never for an authentication failure.
      ...(isProduction || statusCode === 401 ? {} : { stack: err.stack }),
    },
  });
}

module.exports = { ApiError, notFound, errorHandler };

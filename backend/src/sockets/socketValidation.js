const mongoose = require('mongoose');

/**
 * Payload validation for Socket.IO events.
 *
 * Express routes get express-validator; socket events got nothing at all -
 * handlers took `payload.warehouseId` and `payload.deltaSeconds` straight
 * from the wire. A client could send an object where an id was expected
 * (which then reached a Mongo query), a `deltaSeconds` of `1e9` (one
 * "tick" simulating 31 years of movement in a single blocking loop), or a
 * `NaN`. These helpers are the socket-side equivalent, kept deliberately
 * small and total: every one returns a validated value or throws, and the
 * dispatcher in index.js turns a throw into an `error:validation` event
 * rather than an unhandled rejection.
 */
class SocketValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SocketValidationError';
  }
}

/** Socket.IO hands the handler whatever the client serialised - including
 * `undefined`, a string, or an array. Normalise to an object first. */
function asObject(payload) {
  if (payload === null || payload === undefined) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SocketValidationError('payload must be an object');
  }
  return payload;
}

/** Accepts the bare-string form (`warehouse:join` takes an id directly)
 * as well as `{ warehouseId }`. */
function requireWarehouseId(payload) {
  const raw = typeof payload === 'string' ? payload : asObject(payload).warehouseId;

  if (typeof raw !== 'string') {
    throw new SocketValidationError('warehouseId must be a string');
  }
  if (!mongoose.Types.ObjectId.isValid(raw)) {
    throw new SocketValidationError('warehouseId must be a valid Mongo ObjectId');
  }
  return raw;
}

/**
 * A tick's delta must be a small positive number of seconds. The upper
 * bound is the important half: the engine advances every robot by
 * `speed * deltaSeconds` cells inside one synchronous loop, so an
 * unbounded value is a single event that blocks the process.
 */
function optionalDeltaSeconds(payload, { min = 0.001, max = 10 } = {}) {
  const value = asObject(payload).deltaSeconds;
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SocketValidationError('deltaSeconds must be a finite number');
  }
  if (value < min || value > max) {
    throw new SocketValidationError(`deltaSeconds must be between ${min} and ${max}`);
  }
  return value;
}

/**
 * Whether a simulation should keep running once nobody is watching it.
 *
 * Strict about the type rather than truthiness-coercing: `background` is
 * the difference between a loop that stops when the last tab closes and
 * one that keeps a warehouse ticking, so a client sending `"false"` (a
 * string, and therefore truthy) must be told it made a mistake rather than
 * quietly getting the opposite of what it asked for.
 */
function optionalBoolean(payload, field) {
  const value = asObject(payload)[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new SocketValidationError(`${field} must be a boolean`);
  }
  return value;
}

function optionalCount(payload, { min = 1, max = 100 } = {}) {
  const value = asObject(payload).count;
  if (value === undefined || value === null) return undefined;

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SocketValidationError(`count must be an integer between ${min} and ${max}`);
  }
  return value;
}

module.exports = {
  SocketValidationError,
  asObject,
  requireWarehouseId,
  optionalDeltaSeconds,
  optionalBoolean,
  optionalCount,
};

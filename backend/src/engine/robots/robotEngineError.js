class RobotEngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RobotEngineError';
    this.code = code; // machine-readable, e.g. 'ROBOT_NOT_FOUND'
  }
}

module.exports = RobotEngineError;

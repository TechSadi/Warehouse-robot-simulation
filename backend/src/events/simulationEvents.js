const { EventEmitter } = require('events');

/**
 * Central event bus decoupling the simulation engine/services from the
 * transport that broadcasts them (Milestone 11). Controllers and services
 * (tickRunner, orderService, warehouse.controller, robot.controller) emit
 * domain events here; src/sockets/index.js is the only thing that listens,
 * translating each event into a Socket.IO broadcast to the right
 * warehouse's room. Keeping this indirection means every pre-Milestone-11
 * test (which mocks simulationManager/orderService directly and never
 * loads src/sockets/index.js) never needs to know Socket.IO exists -
 * emitting into an unlistened bus is just a no-op.
 *
 * Event catalogue - payload always includes `warehouseId` (string):
 *   robots:changed    { warehouseId, robots: RobotSnapshot[] }
 *                      One or more robots were created or had their
 *                      physical state change (tick movement, a task
 *                      assigned, charging started, an error cleared, a
 *                      manual create/update). Consumers should upsert by
 *                      `id`, not replace their whole robot list.
 *   robots:removed    { warehouseId, robotId }
 *   orders:changed    { warehouseId, reason, ... }
 *                      Treated as an invalidation signal, not a diff - see
 *                      the note in frontend/src/state/useLiveSimulation.js.
 *   obstacles:changed { warehouseId, obstacles: Obstacle[] }
 *                      Always the *full* current obstacle list (cheap -
 *                      there are never many), so consumers can replace
 *                      their obstacle state outright rather than merge.
 *   notification      { warehouseId, level, message, timestamp }
 */
const simulationEvents = new EventEmitter();

// Several long-lived subscriptions (one per event type, registered once in
// sockets/index.js) share this single bus for the life of the process -
// raise the default limit so Node's "possible memory leak" warning doesn't
// fire for what is, here, entirely expected.
simulationEvents.setMaxListeners(50);

module.exports = simulationEvents;

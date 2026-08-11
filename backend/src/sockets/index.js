const { Server } = require('socket.io');
const env = require('../config/env');
const simulationEvents = require('../events/simulationEvents');
const { TickLoopManager, room } = require('./tickLoopManager');

/**
 * Attaches Socket.IO to the given HTTP server and wires up Milestone 11's
 * real-time layer on top of it:
 *
 *  - Clients join a per-warehouse room (`warehouse:<id>`) via
 *    `warehouse:join` to receive that warehouse's robot/order/obstacle/
 *    notification events, and leave it via `warehouse:leave`.
 *  - `simulation:start` / `simulation:stop` control one server-owned tick
 *    interval per warehouse (tickLoopManager.js), shared by every client
 *    watching that warehouse, rather than each client driving its own
 *    REST-polling loop the way Milestone 10's dashboard did.
 *  - simulationEvents (emitted by tickRunner, orderService, and the
 *    warehouse/robot controllers - see src/events/simulationEvents.js) are
 *    forwarded to the matching warehouse room. These subscriptions are
 *    registered once per process, not per connection.
 */
function initSockets(httpServer) {
  const io = new Server(httpServer, {
    path: env.socketPath,
    cors: {
      origin: env.clientOrigins,
      methods: ['GET', 'POST'],
    },
  });

  const tickLoopManager = new TickLoopManager(env.tickIntervalMs);

  io.on('connection', (socket) => {
    console.log(`[socket] Client connected: ${socket.id}`);

    socket.emit('server:welcome', {
      message: 'Connected to warehouse simulation server',
      timestamp: new Date().toISOString(),
    });

    socket.on('warehouse:join', (warehouseId) => {
      if (!warehouseId) return;
      socket.join(room(warehouseId));
    });

    socket.on('warehouse:leave', (warehouseId) => {
      if (!warehouseId) return;
      socket.leave(room(warehouseId));
      tickLoopManager.stopIfIdle(io, warehouseId);
    });

    socket.on('simulation:start', (payload = {}) => {
      const { warehouseId, deltaSeconds } = payload;
      if (!warehouseId) return;
      tickLoopManager.start(io, warehouseId, deltaSeconds);
    });

    socket.on('simulation:stop', (payload = {}) => {
      const { warehouseId } = payload;
      if (!warehouseId) return;
      tickLoopManager.stop(io, warehouseId);
    });

    // Socket.IO removes a disconnecting socket from its rooms before the
    // 'disconnect' event fires, so the warehouse rooms it was watching
    // have to be captured here (while socket.rooms is still populated)
    // and acted on once the leave has actually taken effect below.
    let roomsToCheck = [];
    socket.on('disconnecting', () => {
      roomsToCheck = [...socket.rooms].filter((r) => r.startsWith('warehouse:'));
    });

    socket.on('disconnect', (reason) => {
      console.log(`[socket] Client disconnected: ${socket.id} (${reason})`);
      for (const r of roomsToCheck) {
        tickLoopManager.stopIfIdle(io, r.slice('warehouse:'.length));
      }
    });
  });

  simulationEvents.on('robots:changed', ({ warehouseId, robots }) => {
    io.to(room(warehouseId)).emit('robots:changed', { warehouseId, robots });
  });
  simulationEvents.on('robots:removed', ({ warehouseId, robotId }) => {
    io.to(room(warehouseId)).emit('robots:removed', { warehouseId, robotId });
  });
  simulationEvents.on('orders:changed', (payload) => {
    io.to(room(payload.warehouseId)).emit('orders:changed', payload);
  });
  simulationEvents.on('obstacles:changed', ({ warehouseId, obstacles }) => {
    io.to(room(warehouseId)).emit('obstacles:changed', { warehouseId, obstacles });
  });
  simulationEvents.on('notification', (payload) => {
    io.to(room(payload.warehouseId)).emit('notification', payload);
  });

  initSockets.tickLoopManager = tickLoopManager;
  return io;
}

module.exports = initSockets;

const { Server } = require('socket.io');
const env = require('../config/env');
const simulationEvents = require('../events/simulationEvents');
const { TickLoopManager, room } = require('./tickLoopManager');
const { socketAuthMiddleware } = require('./socketAuth');
const { createSocketLimiter } = require('./socketRateLimit');
const {
  SocketValidationError,
  requireWarehouseId,
  optionalDeltaSeconds,
} = require('./socketValidation');
const { findOwnedWarehouse } = require('../middleware/authorize');

/**
 * Attaches Socket.IO to the given HTTP server and wires up Milestone 11's
 * real-time layer on top of it:
 *
 *  - Clients join a per-warehouse room (`warehouse:<id>`) via
 *    `warehouse:join` to receive that warehouse's robot/order/obstacle/
 *    notification events, and leave it via `warehouse:leave`.
 *  - `simulation:start` / `simulation:stop` control one server-owned tick
 *    interval per warehouse (tickLoopManager.js), shared by every client
 *    watching that warehouse.
 *  - simulationEvents (emitted by tickRunner, orderService, and the
 *    warehouse/robot controllers) are forwarded to the matching warehouse
 *    room. These subscriptions are registered once per process, not per
 *    connection.
 *
 * Security (added in the hardening phase). Every one of these is enforced
 * here rather than in the individual handlers, because a handler is
 * exactly the place a check gets forgotten:
 *
 *  1. Connection authentication - the handshake must carry a valid access
 *     token (socketAuth.js), so an anonymous client cannot open a socket
 *     at all.
 *  2. Room authorization - joining `warehouse:<id>` requires *owning* that
 *     warehouse. This is the socket-side IDOR: rooms are the read channel
 *     for live robot positions and order events, and a room name is just a
 *     string a client supplies.
 *  3. Payload validation - socketValidation.js, before any value reaches a
 *     Mongo query or the engine.
 *  4. Event rate limiting - socketRateLimit.js, per socket and per event.
 *  5. Authorization on *every* warehouse-scoped event, not only on join.
 *     Checking at join time alone would leave `simulation:start` for an
 *     unjoined warehouse wide open - starting someone else's simulation
 *     does not require being able to see it.
 */
function initSockets(httpServer) {
  const io = new Server(httpServer, {
    path: env.socketPath,
    cors: {
      // Same explicit allow-list as the REST API. Socket.IO's CORS is
      // separate from Express's and would default to permissive.
      origin: env.clientOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    // Bound how much a single client can push in one frame. The default is
    // 1MB per message; nothing this API accepts over a socket is larger
    // than a few hundred bytes.
    maxHttpBufferSize: 64 * 1024,
    // Drop connections that stop responding rather than holding the
    // room/tick-loop state they are keeping alive.
    pingTimeout: 20000,
  });

  io.use(socketAuthMiddleware);

  const tickLoopManager = new TickLoopManager(env.tickIntervalMs);

  io.on('connection', (socket) => {
    const limit = createSocketLimiter(socket);
    console.log(`[socket] Client connected: ${socket.id} (user ${socket.data.userId})`);

    socket.emit('server:welcome', {
      message: 'Connected to warehouse simulation server',
      userId: String(socket.data.userId),
      timestamp: new Date().toISOString(),
    });

    /**
     * One wrapper for every warehouse-scoped event: rate limit, validate,
     * then authorize - in that order, so an unauthorized caller spends its
     * own budget before it costs us a database round trip.
     */
    function guarded(eventName, handler) {
      socket.on(eventName, async (payload) => {
        try {
          if (!limit(eventName)) return;

          const warehouseId = requireWarehouseId(payload);
          const warehouse = await findOwnedWarehouse(warehouseId, socket.data.userId);
          if (!warehouse) {
            // Same non-committal wording as the REST 404: a client must
            // not be able to tell "does not exist" from "not yours" by
            // sweeping ObjectIds over this socket.
            socket.emit('error:unauthorized', { event: eventName, message: 'Warehouse not found' });
            return;
          }

          await handler({ warehouseId: String(warehouse._id), warehouse, payload });
        } catch (err) {
          if (err instanceof SocketValidationError) {
            socket.emit('error:validation', { event: eventName, message: err.message });
            return;
          }
          console.error(`[socket] ${eventName} failed:`, err.message);
          socket.emit('error:server', { event: eventName, message: 'Request failed' });
        }
      });
    }

    guarded('warehouse:join', ({ warehouseId }) => {
      socket.join(room(warehouseId));
      socket.emit('warehouse:joined', { warehouseId });
    });

    guarded('warehouse:leave', ({ warehouseId }) => {
      socket.leave(room(warehouseId));
      tickLoopManager.stopIfIdle(io, warehouseId);
    });

    guarded('simulation:start', ({ warehouseId, payload }) => {
      const deltaSeconds = optionalDeltaSeconds(payload);
      tickLoopManager.start(io, warehouseId, deltaSeconds);
    });

    guarded('simulation:stop', ({ warehouseId }) => {
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

  // Broadcasts are addressed to `warehouse:<id>` rooms, and membership of
  // those rooms is ownership-checked at join time above - so these
  // forwards cannot reach a socket that was never authorized for the
  // warehouse in question.
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

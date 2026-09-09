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
const simulationManager = require('../services/simulationManager');

/**
 * Attaches Socket.IO to the given HTTP server and wires up Milestone 11's
 * real-time layer on top of it:
 *
 *  - Clients join a per-warehouse room (`warehouse:<id>`) via
 *    `warehouse:join` to receive that warehouse's robot/order/obstacle/
 *    notification events, and leave it via `warehouse:leave`. Joining
 *    always answers with a full `simulation:sync` snapshot plus the
 *    current `simulation:status`, and `simulation:sync` can be requested
 *    again at any time - see the note on resynchronisation below.
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
 *
 * Resynchronisation (added in the reliability phase). Socket.IO reconnects
 * transparently, and a client that reconnects has *not* stayed
 * synchronised: room membership is dropped server-side on disconnect, and
 * every robot/order/obstacle event broadcast during the gap is gone - they
 * are fire-and-forget broadcasts, not a replayable stream. The previous
 * design left the client silently displaying whatever state it had when
 * the connection dropped, including a Start/Stop button reflecting a
 * simulation status that may have changed twice since. So: joining a room
 * (which a reconnecting client redoes) always returns an authoritative
 * snapshot, `simulation:sync` can be asked for explicitly, and
 * `simulation:status` is sent to the requester on every start/stop even
 * when the call changed nothing.
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
    //
    // Both halves of the heartbeat are set, and both are shorter than the
    // defaults, because these values are what decides how long *either*
    // side keeps believing in a connection that is already gone. The server
    // sends them to the client during the handshake, so they also govern
    // how fast a browser notices - with the defaults (25s interval, this
    // 20s timeout) a client whose network vanished went on displaying a
    // frozen fleet under a "Live" label for up to 45 seconds. At 10s/10s
    // that worst case is 20 seconds, for one extra heartbeat frame per
    // socket per 15 seconds, which is nothing next to a tick broadcast
    // twice a second.
    pingInterval: 10000,
    pingTimeout: 10000,
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

    /** The authoritative current state of one warehouse's simulation, as
     * the server sees it right now. Robots come from the live engine
     * rather than from Mongo so the client gets sub-tick-accurate
     * positions, and `running` comes from the tick loop rather than from
     * whatever the client last assumed. Orders are deliberately not
     * included: they are fetched over REST (see the note on
     * `orders:changed` in events/simulationEvents.js), and `reason: 'sync'`
     * below is what tells the client to do that. */
    async function buildSync(warehouseId) {
      const engine = await simulationManager.getEngine(warehouseId);
      return {
        warehouseId,
        running: tickLoopManager.isRunning(warehouseId),
        robots: engine ? engine.getAllRobots() : [],
        obstacles: engine ? engine.getObstacles() : [],
        serverTime: new Date().toISOString(),
      };
    }

    async function sendSync(warehouseId) {
      socket.emit('simulation:sync', await buildSync(warehouseId));
      socket.emit('simulation:status', tickLoopManager.status(warehouseId));
      // The client refetches orders over REST on this signal, which is how
      // it recovers order state it may have missed while disconnected.
      socket.emit('orders:changed', { warehouseId, reason: 'sync' });
    }

    guarded('warehouse:join', async ({ warehouseId }) => {
      socket.join(room(warehouseId));
      socket.emit('warehouse:joined', { warehouseId });
      await sendSync(warehouseId);
    });

    guarded('simulation:sync', async ({ warehouseId }) => {
      await sendSync(warehouseId);
    });

    guarded('warehouse:leave', ({ warehouseId }) => {
      socket.leave(room(warehouseId));
      tickLoopManager.stopIfIdle(io, warehouseId);
    });

    // Both of these are idempotent, and both answer the requester
    // directly even when they changed nothing. A second `simulation:start`
    // is not an error - it means "I want this running", and it already is
    // - but a client that hears nothing back cannot tell that from a
    // request that was dropped.
    guarded('simulation:start', ({ warehouseId, payload }) => {
      const deltaSeconds = optionalDeltaSeconds(payload);
      const { started } = tickLoopManager.start(io, warehouseId, deltaSeconds);
      socket.emit('simulation:status', { ...tickLoopManager.status(warehouseId), changed: started });
    });

    guarded('simulation:stop', ({ warehouseId }) => {
      const { stopped } = tickLoopManager.stop(io, warehouseId);
      socket.emit('simulation:status', { warehouseId, running: false, changed: stopped });
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
  // A deleted warehouse must not keep a tick loop running against an
  // engine that no longer has anything to advance, and the clients still
  // in its room need to be told rather than left watching a frozen view.
  // Emitted by warehouse.controller.js, which has no reference to the
  // socket layer - same indirection as every other event here.
  simulationEvents.on('warehouse:deleted', ({ warehouseId }) => {
    tickLoopManager.stop(io, warehouseId);
    io.to(room(warehouseId)).emit('warehouse:deleted', { warehouseId });
    io.socketsLeave(room(warehouseId));
  });

  initSockets.tickLoopManager = tickLoopManager;
  return io;
}

module.exports = initSockets;

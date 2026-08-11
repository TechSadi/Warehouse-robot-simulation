# API Reference

Base URL (local dev): `http://localhost:5000/api`
Socket.IO path: `/socket.io` (same host as the API)

In production these are wherever you deployed the backend - see
[`DEPLOYMENT.md`](./DEPLOYMENT.md). The frontend picks up the backend's
URL from `VITE_API_URL`/`VITE_SOCKET_URL` at build time (see
[`frontend/.env.example`](../frontend/.env.example)); nothing below
changes based on where it's hosted.

## Conventions

**Response envelope.** Every response is JSON with a `success` boolean.

```json
// success
{ "success": true, "data": { /* ... */ } }

// success, list endpoint
{ "success": true, "data": [ /* ... */ ], "meta": { "page": 1, "limit": 20, "total": 42, "pages": 3 } }

// failure
{ "success": false, "error": { "message": "Robot not found" } }
```

A validation failure's `error` includes a `details` array of
`{ field, message }` pairs. In non-production environments, 500-level
errors also include `error.stack`; production omits it.

**Pagination.** List endpoints accept `?page=1&limit=20` (`limit` capped
at 100, defaults to 20) and return the `meta` block shown above.

**IDs.** Every `:id` is a MongoDB ObjectId. An invalid one returns `400`,
not `404`.

**Auth.** None. This is a demo/portfolio project - see the
[Architecture doc's security note](./ARCHITECTURE.md#security-notes)
before using this as a template for anything handling real data.

---

## Health

### `GET /health`

Always returns `200` if the process is up, regardless of database state -
suitable for a PaaS health check. Reports the Mongo connection state
rather than requiring it.

```json
{
  "success": true,
  "data": {
    "service": "warehouse-robot-simulation-backend",
    "status": "ok",
    "uptimeSeconds": 431,
    "database": "connected",
    "timestamp": "2026-08-10T12:00:00.000Z"
  }
}
```

---

## Warehouses

A warehouse is a saved grid layout: dimensions, a sparse list of non-empty
cells (`shelf` / `charging` / `obstacle` / `dock`), and which order→robot
scheduling strategy it uses. See [`ER_DIAGRAM.md`](./ER_DIAGRAM.md) for
how this relates to robots, orders, statistics, and logs.

| Method | Path | Description |
|---|---|---|
| GET | `/warehouses` | List, filterable by `isActive` |
| GET | `/warehouses/:id` | Get one |
| POST | `/warehouses` | Create |
| PUT | `/warehouses/:id` | Update (partial) |
| DELETE | `/warehouses/:id` | Delete |
| PATCH | `/warehouses/:id/activate` | Mark active, deactivate every other warehouse |
| POST | `/warehouses/:id/path` | Run A* between two cells |
| POST | `/warehouses/:id/tick` | Manually advance the live simulation once |
| GET | `/warehouses/:id/obstacles` | List active dynamic obstacles |
| POST | `/warehouses/:id/obstacles` | Add a dynamic obstacle |
| DELETE | `/warehouses/:id/obstacles/:obstacleId` | Remove a dynamic obstacle |
| POST | `/warehouses/:id/orders/generate` | Generate random pending orders |
| POST | `/warehouses/:id/orders/dispatch` | Assign pending orders to idle robots |

### `POST /warehouses`

```json
// request
{
  "name": "Main Floor",
  "rows": 30,
  "cols": 40,
  "cells": [{ "x": 5, "y": 5, "type": "shelf" }],
  "schedulingStrategy": "nearest_robot"
}
```
`rows`/`cols`: integers, 5-80. `cells[].type`: one of `shelf`, `charging`,
`obstacle`, `dock`. `schedulingStrategy`: one of `first_come_first_serve`,
`nearest_robot`, `least_busy`, `round_robin`, `priority_queue` (default
`nearest_robot`). Every field but `name`/`rows`/`cols` is optional.

### `POST /warehouses/:id/path`

Runs the A* engine directly against a saved layout - the same one the
Robot Engine uses internally, exposed for inspection and for the AI
Visualisation Panel.

```json
// request
{
  "start": { "x": 0, "y": 0 },
  "goal": { "x": 10, "y": 10 },
  "heuristic": "manhattan",
  "allowDiagonal": false,
  "trace": false
}
```
`heuristic`: `manhattan` (default) | `euclidean` | `diagonal`. With
`trace: true`, the response also includes `steps` (the full open/closed
set at each expansion, capped at 400 recorded frames - see
[`ARCHITECTURE.md`](./ARCHITECTURE.md#pathfinding)) and `stepsTruncated`.

```json
// response (trace: false)
{
  "success": true,
  "data": {
    "found": true,
    "path": [{ "x": 0, "y": 0 }, "..."],
    "cost": 14,
    "nodesExplored": 23,
    "executionTimeMs": 0.42
  }
}
```

### `POST /warehouses/:id/tick`

Advances the live simulation by `deltaSeconds` (default `1`, max `10`):
moves every robot, processes pickup/delivery transitions, dispatches
newly-idle robots onto pending orders. This is the same function the
server-owned Socket.IO tick loop calls automatically every 500ms while a
simulation is running (see [`ARCHITECTURE.md`](./ARCHITECTURE.md#the-tick-loop))
- this endpoint is for scripting a single step without a socket
connection, not how the live dashboard advances the simulation.

### `POST /warehouses/:id/obstacles`

```json
// request
{
  "id": "forklift-1",
  "type": "human_worker",
  "cells": [{ "x": 5, "y": 5 }],
  "durationSeconds": 30
}
```
`type`: `human_worker` | `temporary_obstacle` | `broken_robot` |
`construction_zone`. Omit `durationSeconds` for one that doesn't expire
on its own.

---

## Robots

| Method | Path | Description |
|---|---|---|
| GET | `/robots` | List, filterable by `warehouseId`, `status` |
| GET | `/robots/:id` | Get one |
| POST | `/robots` | Create (spawn) |
| PUT | `/robots/:id` | Update |
| DELETE | `/robots/:id` | Delete |
| POST | `/robots/:id/tasks` | Assign a destination |
| POST | `/robots/:id/charge` | Start charging (must be on a `charging` cell) |
| POST | `/robots/:id/clear-error` | Clear an error state |
| POST | `/robots/:id/break` | Mark broken (creates a dynamic hazard other robots route around) |

`status` is one of `idle`, `moving`, `charging`, `error`.

### `POST /robots`

```json
{ "name": "R1", "warehouseId": "<id>", "position": { "x": 0, "y": 0 }, "speed": 2, "battery": 100 }
```
Note: creating a robot this way adds it to MongoDB, but if the
warehouse's live in-memory engine was already built before this call, it
won't retroactively pick up the new robot until the engine cache is next
rebuilt - see the known limitation in
[`ARCHITECTURE.md`](./ARCHITECTURE.md#known-limitations).

### `POST /robots/:id/tasks`

```json
{ "destination": { "x": 12, "y": 8 } }
```
Queues a destination; the robot starts moving toward it (or fails with a
`RobotEngineError` if unreachable). Battery below 20% with nothing queued
triggers autonomous charging-station routing instead - see the Milestone
13 note in the [development log](./DEVELOPMENT_LOG.md).

---

## Orders

| Method | Path | Description |
|---|---|---|
| GET | `/orders` | List, filterable by `warehouseId`, `status`, `priority` |
| GET | `/orders/:id` | Get one |
| POST | `/orders` | Create |
| PUT | `/orders/:id` | Update |
| DELETE | `/orders/:id` | Delete |

`status`: `pending` → `assigned` → `picked_up` → `delivered` (or
`cancelled` at any point). `priority`: `low` | `normal` | `high` |
`urgent`. In normal use, orders are created via
`POST /warehouses/:id/orders/generate` and progress automatically as the
simulation ticks; this CRUD surface exists for direct inspection/testing
and manual scripting.

```json
// POST /orders
{
  "warehouseId": "<id>",
  "pickupLocation": { "x": 2, "y": 2 },
  "deliveryLocation": { "x": 20, "y": 15 },
  "priority": "normal"
}
```

---

## Statistics

Append-only fleet-metric snapshots - there's deliberately no update
endpoint.

| Method | Path | Description |
|---|---|---|
| GET | `/statistics` | List, filterable by `warehouseId`, `from`/`to` (ISO 8601) |
| GET | `/statistics/:id` | Get one |
| POST | `/statistics` | Record a snapshot |
| DELETE | `/statistics/:id` | Delete one |

```json
// POST /statistics
{
  "warehouseId": "<id>",
  "metrics": { "activeRobots": 12, "idleRobots": 3, "pendingOrders": 8, "completedOrders": 140, "avgBattery": 76.2, "deliveriesPerHour": 22.5 }
}
```

---

## Logs

Also append-only (no update endpoint). Populated automatically by the
simulation (robot errors, deliveries, unreachable destinations - see
`tickRunner.js` and `orderService.js`) and readable via this API - the
Logs panel in the dashboard (Milestone 13) is a thin client over this.

| Method | Path | Description |
|---|---|---|
| GET | `/logs` | List, filterable by `warehouseId`, `level`, `source` |
| GET | `/logs/:id` | Get one |
| POST | `/logs` | Create manually |
| DELETE | `/logs/:id` | Delete one |

`level`: `info` | `warn` | `error`.

---

## Socket.IO events

Connect with `path: '/socket.io'`. Every event below is scoped to a
warehouse "room" - join one to receive its events, and note that no
authentication gates this: anyone who knows a warehouse's id can join its
room. See the
[Architecture doc's security note](./ARCHITECTURE.md#security-notes).

### Client → server

| Event | Payload | Effect |
|---|---|---|
| `warehouse:join` | `warehouseId` (string) | Start receiving that warehouse's events |
| `warehouse:leave` | `warehouseId` | Stop receiving them |
| `simulation:start` | `{ warehouseId, deltaSeconds? }` | Start (or join) that warehouse's server-owned tick loop |
| `simulation:stop` | `{ warehouseId }` | Stop it |

### Server → client

| Event | Payload | When |
|---|---|---|
| `server:welcome` | `{ message, timestamp }` | On connect |
| `robots:changed` | `{ warehouseId, robots: [...] }` | One or more robots moved or changed state - upsert by `id`, this may be a partial list |
| `robots:removed` | `{ warehouseId, robotId }` | A robot was deleted |
| `orders:changed` | `{ warehouseId, reason, ... }` | An invalidation signal, not a diff - re-fetch orders for this warehouse when you see it |
| `obstacles:changed` | `{ warehouseId, obstacles: [...] }` | Always the full current obstacle list |
| `notification` | `{ warehouseId, level, message, timestamp }` | A notification-worthy event (robot error, delivery, unreachable destination) |
| `simulation:status` | `{ warehouseId, running }` | The tick loop started or stopped - including for clients who didn't request the change themselves |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md#real-time-layer) for how these
map onto the server-side event bus and the server-owned tick loop.

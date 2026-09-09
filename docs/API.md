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

**Auth.** Required. Every endpoint except `GET /health` and `/auth/*`
needs a session; without one they return `401`. An account with
multi-factor authentication enabled answers `POST /auth/login` with `401`
and `error.details.code = "MFA_REQUIRED"` until the request also carries
`mfaCode` or `recoveryCode` - a client that treats every 401 as "wrong
password" will confuse those users. Sign in via
`POST /auth/login`, which sets httpOnly cookies the browser then sends
automatically - browser clients need `credentials: 'include'` on every
request and must echo the readable `wrs_csrf` cookie in an `X-CSRF-Token`
header on any non-GET. Non-browser clients may send
`Authorization: Bearer <access token>` instead, which is exempt from CSRF.

**Authorization.** Every robot, order, obstacle, statistic and log belongs
to a warehouse, and every warehouse has one owner and any number of
collaborators. Each route names the access level it needs - `view`, `edit`
or `own`:

- A warehouse the caller cannot reach **at all** returns `404`, identical
  to one that never existed - deliberately, so ids cannot be enumerated.
- A warehouse the caller can reach but **not far enough** returns `403`,
  with `error.details` naming the level `required` and the level `granted`.
  There is nothing left to conceal at that point, and "you may look but not
  touch" is useful to be told.

List endpoints are scoped to what the caller can reach, and warehouse
listings carry an `access` field per entry so a client can render a shared
warehouse read-only without discovering that by collecting a 403.

**Busy warehouses.** Operations that mutate one warehouse's live
simulation - ticking, dispatching, changing obstacles, creating or
deleting robots - run one at a time per warehouse. Requests wait their
turn rather than interleaving. If a warehouse is so backed up that more
than 32 are already queued, further ones are rejected with `503` instead
of being added to the queue. See
[`SIMULATION_ARCHITECTURE.md`](./SIMULATION_ARCHITECTURE.md#3-concurrency-model).

Full details in [`SECURITY.md`](./SECURITY.md).

---

## Authentication

| Method | Path | Description |
|---|---|---|
| POST | `/auth/register` | Create an account and sign in. `{ email, password, name? }` |
| POST | `/auth/login` | Sign in. `{ email, password }` |
| POST | `/auth/refresh` | Rotate the session using the refresh cookie |
| POST | `/auth/logout` | Revoke this session |
| POST | `/auth/logout-all` | Revoke every session for the user |
| GET | `/auth/me` | The current user |
| POST | `/auth/password/forgot` | Start a password reset. `{ email }` |
| POST | `/auth/password/reset` | Complete one. `{ token, password }` |
| POST | `/auth/password/change` | Change it while signed in. `{ currentPassword, newPassword }` |
| POST | `/auth/email/verify/request` | Send a confirmation link to the caller's own address |
| POST | `/auth/email/verify` | Confirm. `{ token }` |
| POST | `/auth/mfa/setup` | Generate a TOTP secret and an `otpauth://` URI |
| POST | `/auth/mfa/enable` | Confirm enrolment. `{ code }` → recovery codes |
| POST | `/auth/mfa/disable` | Turn it off. `{ password, code \| recoveryCode }` |

Registration requires a password of at least 12 characters containing
upper case, lower case, and a digit. `role` and every other privileged
field are ignored if sent.

```json
// POST /auth/login -> 200
{
  "success": true,
  "data": {
    "user": { "id": "...", "email": "you@example.com", "name": "", "role": "user" },
    "csrfToken": "...",
    "expiresIn": 900
  }
}
```

Login answers `401 "Invalid email or password"` whether or not the account
exists. Repeated failures are rate-limited per IP and lock the *source
network* out of the account for 15 minutes - per source rather than per
account, so knowing someone's email is not enough to keep them out of their
own account.

`/auth/password/forgot` answers `202` with the same body whether or not the
address has an account, and whether or not mail was actually delivered:
anything else would make it a cleaner account-existence oracle than the
login form. The reset link is single use, expires in 30 minutes, stops
working if the account's address changes, and completing one revokes every
existing session.

**Multi-factor.** Enrolment is two steps - `/mfa/setup` returns a secret to
scan, `/mfa/enable` proves you can read codes from it - so a user who loses
their phone between the two is not locked out by the act of setting it up.
Once enabled, `/auth/login` with only a password answers:

```json
// POST /auth/login -> 401
{
  "success": false,
  "error": { "message": "A verification code from your authenticator app is required",
             "details": { "code": "MFA_REQUIRED" } }
}
```

Retry with `mfaCode` (six digits) or `recoveryCode`. A code whose time step
has already been accepted is refused with `MFA_REPLAY`, so one captured and
relayed by a phishing page does not work twice. Recovery codes are single
use and shown exactly once, at `/mfa/enable`.

---

## Administration

Requires the `admin` role. Deliberately narrow: an admin can see *about*
users and can end their sessions, and has no route to act *as* them - no
impersonation, no password setting, and no way to read another user's
warehouses. Authorization in this API is access-based, and an admin bypass
would make every access check conditional on a role.

| Method | Path | Description |
|---|---|---|
| GET | `/admin/users` | List accounts, filterable by `email`/`role` |
| GET | `/admin/users/:id` | One account: verification, MFA, session count, active lockouts |
| POST | `/admin/users/:id/revoke-sessions` | End every session and clear lockouts |
| GET | `/admin/security-events` | The audit trail, filterable by `type`/`outcome`/`email`/`userId` |
| GET | `/admin/status` | This instance: uptime, cached engines, warehouses being simulated |

Every one of these is itself written to the audit trail, including the
reads - an administrator looking through the security log is a security
event.

---

## Telemetry

| Method | Path | Description |
|---|---|---|
| POST | `/telemetry/client-errors` | Where the dashboard reports its own render failures |

Authenticated, rate-limited, and everything in it treated as hostile text:
`level` and `source` are server-assigned, so a client cannot author a log
line that appears to have come from the simulation engine. A report may
name a `warehouseId` so it lands in that warehouse's Logs panel; naming one
the caller cannot reach drops the association rather than the report.

---

## Health

### `GET /health`

Always returns `200` if the process is up, regardless of database state -
suitable for a PaaS health check, which is all this endpoint is for.

It is the only unauthenticated route outside `/auth`, so it reports only
that the process is serving requests. It used to also return uptime and the
database connection state, which is a small but real disclosure to anyone
who asks: uptime dates a deployment, and a database state flipping to
`disconnected` says exactly when the service is least able to defend
itself. Neither is something a health check needs.

```json
{
  "success": true,
  "data": {
    "service": "warehouse-robot-simulation-backend",
    "status": "ok"
  }
}
```

### `GET /health/details`

The operator's view - authenticated. Everything the public probe used to
report.

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
| DELETE | `/warehouses/:id` | Delete, **cascading** to the warehouse's robots, orders, statistics and logs |
| PATCH | `/warehouses/:id/activate` | Mark active, deactivate every other warehouse |
| POST | `/warehouses/:id/path` | Run A* between two cells |
| POST | `/warehouses/:id/tick` | Manually advance the live simulation once |
| GET | `/warehouses/:id/obstacles` | List active dynamic obstacles |
| POST | `/warehouses/:id/obstacles` | Add a dynamic obstacle |
| DELETE | `/warehouses/:id/obstacles/:obstacleId` | Remove a dynamic obstacle |
| POST | `/warehouses/:id/orders/generate` | Generate random pending orders |
| POST | `/warehouses/:id/orders/dispatch` | Assign pending orders to idle robots |
| GET | `/warehouses/:id/collaborators` | Who else can reach it (owner only) |
| POST | `/warehouses/:id/collaborators` | Share it. `{ email, role: viewer \| editor }` (owner only) |
| DELETE | `/warehouses/:id/collaborators/:userId` | Stop sharing (owner only) |

The access level each of these needs is not the one the HTTP verb suggests,
and is stated deliberately:

| Level | Routes |
|---|---|
| `view` | `GET /:id`, `GET /:id/obstacles`, `POST /:id/path` |
| `edit` | `POST /:id/tick`, the obstacle writes, order generation and dispatch |
| `own` | `PUT /:id` (it can reshape the layout, which reloads the engine and requeues in-flight orders), `DELETE /:id`, `PATCH /:id/activate`, and all three collaborator routes |

Collaborators are addressed by **email**, not by user id: an id is not
something one person knows about another, and an endpoint that resolved one
would be an enumeration oracle over the user table. Inviting an address
with no account answers exactly as if it had one, for the same reason.
There is no `owner` role to grant - so no amount of sharing can produce a
warehouse with two people who can each remove the other.

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

A manual tick arriving while the automatic loop is mid-tick waits and is
then applied as a whole, separate step - it is never interleaved with one.
Returns `503` if the warehouse's operation queue is already full.

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

Obstacles are runtime hazards rather than part of the saved *layout* -
editing the floor plan does not touch them - but they are **persisted** on
the warehouse document, so they survive a restart, a layout edit and an
engine-cache eviction. `durationSeconds` counts down in *simulation* time,
not wall-clock: a warehouse that was not running while the process was down
comes back with the same time left on the clock it had when it stopped.

`GET /warehouses/:id/obstacles` reads the live set when an engine happens to
be loaded and the stored set otherwise. It never builds an engine, so a
read cannot trigger the reconciliation pass an engine load performs.

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
The robot joins the warehouse's live engine immediately if one is loaded,
registered inside the warehouse lock so it lands cleanly between two ticks
rather than part-way through one. `position` must name a whole cell inside
the warehouse: a fractional position is not a cell the engine can spawn on,
and accepting one would create a robot that exists in MongoDB and can never
join the simulation.

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

**Lifecycle.** `status` follows a state machine, not a free enum:

```
pending -> assigned -> picking_up -> picked_up -> delivering -> delivered
```

with `cancelled` reachable from any non-terminal state, and `delivered`
and `cancelled` terminal. The simulation advances a leg at a time
(`assigned -> picked_up -> delivered`), which are legal forward moves
along the same chain; the in-transit states are there for clients driving
an order by hand.

An illegal move returns `409` with
`details.code: "INVALID_ORDER_TRANSITION"` - `pending -> delivered` and
`delivered -> pending` are both rejected, as is any edit to an order that
has already reached a terminal state. The REST API and the simulation
engine share one implementation of these rules
([`SECURITY.md`](./SECURITY.md#4-domain-state-protection)).

`status` is **not** accepted on create - every order starts `pending`.
Neither are `assignedRobot` or any `*At` timestamp: those are recorded by
the server when the transition happens, and sending one returns `422`.
Pickup and delivery coordinates can only be changed while an order is
still `pending`.

`priority`: `low` | `normal` | `high` | `urgent`. In normal use, orders
are created via `POST /warehouses/:id/orders/generate` and progress
automatically as the simulation ticks; this CRUD surface exists for direct
inspection/testing and manual scripting.

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

Connect with `path: '/socket.io'` and `withCredentials: true` (or pass
`auth: { token }` for a non-browser client). **The handshake is
authenticated**: an unauthenticated connection is refused with
`UNAUTHENTICATED` rather than connecting and receiving nothing.

Every event below is scoped to a warehouse "room", and joining one
requires *owning* that warehouse - as does every other warehouse-scoped
event, checked individually rather than only at join time. Events are also
validated and rate-limited per socket. See
[`SECURITY.md`](./SECURITY.md#5-socketio-security).

### Client → server

| Event | Payload | Effect |
|---|---|---|
| `warehouse:join` | `warehouseId` (string) | Start receiving that warehouse's events. Requires `view` access, so a collaborator can watch a shared warehouse. |
| `warehouse:leave` | `warehouseId` | Stop receiving them |
| `simulation:start` | `{ warehouseId, deltaSeconds?, background? }` | Start (or join) that warehouse's server-owned tick loop. Idempotent: starting an already-running warehouse changes nothing, and the reply says so. `background: true` keeps it running once the last client leaves the room, bounded by `MAX_BACKGROUND_SECONDS`; the default stops with the last watcher. Requires `edit` access - starting a simulation changes what everyone else in the room is watching. |
| `simulation:stop` | `{ warehouseId }` | Stop it. Idempotent in the same way. Also requires `edit`. |
| `simulation:sync` | `{ warehouseId }` | Ask for the server's current view of this warehouse. Sent automatically on every join; request it explicitly after a reconnect if you are not rejoining. |

### Server → client (errors)

| Event | Payload | When |
|---|---|---|
| `error:unauthorized` | `{ event, message }` | The caller does not own the warehouse named in the payload. The message is deliberately identical to a nonexistent warehouse's. |
| `error:validation` | `{ event, message }` | Malformed payload - bad id, out-of-range `deltaSeconds`, wrong type |
| `error:rate_limit` | `{ event, message }` | Too many of this event on this socket |
| `error:server` | `{ event, message }` | The handler failed |

An `emit` has nothing to reject, so these arrive as events; a client that
does not listen for them sees a silent no-op.

### Server → client

| Event | Payload | When |
|---|---|---|
| `server:welcome` | `{ message, userId, timestamp }` | On connect |
| `warehouse:joined` | `{ warehouseId }` | A `warehouse:join` was authorized and took effect |
| `robots:changed` | `{ warehouseId, robots: [...] }` | One or more robots moved or changed state - upsert by `id`, this may be a partial list |
| `robots:removed` | `{ warehouseId, robotId }` | A robot was deleted |
| `orders:changed` | `{ warehouseId, reason, ... }` | An invalidation signal, not a diff - re-fetch orders for this warehouse when you see it |
| `obstacles:changed` | `{ warehouseId, obstacles: [...] }` | Always the full current obstacle list |
| `notification` | `{ warehouseId, level, message, timestamp }` | A notification-worthy event (robot error, delivery, unreachable destination) |
| `simulation:status` | `{ warehouseId, running, deltaSeconds?, startedAt?, ticks?, skippedTicks?, failedTicks?, changed? }` | The tick loop started or stopped - broadcast to the room, and also sent directly to whoever asked, even when their request changed nothing (`changed: false`) |
| `simulation:sync` | `{ warehouseId, running, robots: [...], obstacles: [...], serverTime }` | The authoritative current state. Sent on every join and on request. **Replace** your robot and obstacle state with it rather than merging - see below. |
| `warehouse:deleted` | `{ warehouseId }` | The warehouse was deleted. Its tick loop is stopped and the room is emptied. |

### Reconnecting

A Socket.IO client that reconnects has **not** stayed synchronised. Room
membership is dropped server-side on disconnect, and the events broadcast
during the gap are gone - they are fire-and-forget broadcasts, not a
replayable stream. So on `connect`:

1. Re-emit `warehouse:join`. The server answers with `warehouse:joined`,
   then `simulation:sync`, then `simulation:status`, then an
   `orders:changed` with `reason: "sync"`.
2. Replace robots and obstacles from `simulation:sync` rather than merging
   them. Merging preserves exactly the stale entries the resync exists to
   discard - a robot deleted while you were away, for instance, which no
   future `robots:changed` will ever mention again.
3. Re-fetch orders over REST when the `orders:changed` arrives. Order
   documents carry more fields than a tick event does, which is why they
   are invalidated rather than pushed.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md#real-time-layer) for how these
map onto the server-side event bus, and
[`SIMULATION_ARCHITECTURE.md`](./SIMULATION_ARCHITECTURE.md#7-socketio-synchronisation)
for the full synchronisation model.

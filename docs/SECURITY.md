# Security

How authentication, authorization, and the surrounding hardening work in
the Warehouse Robot Simulation, and what they do and do not protect
against.

Before this phase the API and the Socket.IO channel were open. Anyone who
could reach the deployment could list every warehouse, read and drive every
robot, and start or stop any simulation — there was no notion of a user at
all. This document describes what replaced that.

---

## 1. Authentication architecture

### Model

Stateless access tokens, stateful refresh tokens.

| | Access token | Refresh token |
|---|---|---|
| Format | JWT (HS256) | 48 bytes of CSPRNG output, opaque |
| Lifetime | 15 minutes | 30 days |
| Transport | `wrs_access` cookie (httpOnly) | `wrs_refresh` cookie (httpOnly, `Path=/api/auth`) |
| Verified by | signature + claims | SHA-256 digest lookup in `refreshtokens` |
| Revocable | via `tokenVersion` | yes, individually and by family |

The access token is short-lived so a leaked one is worth little. The
refresh token is what actually keeps someone signed in, and because it is
checked against a server-side record it can be revoked — which a plain
stateless JWT refresh token cannot be.

The refresh cookie is scoped to `/api/auth`, so the long-lived credential
is simply not attached to the hundreds of ordinary API calls a running
simulation makes.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` | Create an account and sign in |
| `POST` | `/api/auth/login` | Sign in |
| `POST` | `/api/auth/refresh` | Rotate the session |
| `POST` | `/api/auth/logout` | Revoke this session |
| `POST` | `/api/auth/logout-all` | Revoke every session for the user |
| `GET`  | `/api/auth/me` | The current user |

`/api/health` and `/api/auth/*` are the only routes reachable without a
session. Every other router calls `router.use(requireAuth)` at its top, so
a route added later is authenticated by default rather than by someone
remembering to opt in — the failure mode of per-route opt-in is a
forgotten line, and that failure mode is an open endpoint.

### Password storage

bcrypt, cost factor 12 (configurable via `BCRYPT_ROUNDS`; tests use 4).
The digest lives in `User.passwordHash`, which is `select: false` — no
query returns it unless it asks explicitly, so an accidental
`res.json(user)` anywhere in the app cannot leak it. The field is
deliberately not called `password`: a field holding a digest should be
impossible to confuse with one holding a secret, in review or in a stack
trace.

Registration requires at least 12 characters with upper case, lower case,
and a digit, capped at 200 (bcrypt only reads the first 72 bytes, and
hashing an unbounded string is free CPU for an attacker). Login applies no
strength rules at all — doing so would tell an attacker which of their
guesses could possibly be a real password on this system.

### Abuse protections

**Brute force / credential stuffing.** Two independent layers, because
they stop different attacks:

- Per-IP: 10 failed attempts per 15 minutes on `/api/auth/*`
  (`skipSuccessfulRequests`, so a user is never locked out by their own
  successful logins). Stops one host hammering many accounts.
- Per-account: 8 consecutive failures locks the account for 15 minutes,
  and the lock holds even against the correct password — otherwise it
  would not slow an attacker down at all. Stops a distributed attack
  concentrating on one account.

**Credential enumeration.** Login answers `401 "Invalid email or password"`
whether the account exists or not, and takes comparable time either way:
the unknown-account path still runs a bcrypt comparison against a dummy
hash, because skipping it would make that path measurably faster and leak
the same fact through timing. Registration returns a neutral
`409 "Unable to register with those details"` — it is unavoidable that
registration reveals *something* (two accounts cannot share an email), so
the wording gives nothing extra away and the 5-per-hour limiter bounds how
fast a list can be probed.

**Session fixation.** Every login mints an entirely new token pair, and
each access token carries a unique `jti`, so no session identifier that
existed before authentication survives it. `tokenVersion` on the user
invalidates outstanding access tokens without a server-side blacklist.

**Refresh token theft.** Rotation with reuse detection. Each refresh
consumes its token and issues a successor in the same `family`. Presenting
an already-rotated token means either a replay or a stolen cookie, so the
whole family is revoked and both parties must sign in again — the attacker
does not get to ride along silently.

Only a SHA-256 digest of each refresh token is stored, so a dump of the
collection is useless. SHA-256 rather than bcrypt is correct here: the
token is already 256 bits of CSPRNG output, so there is no low-entropy
guess space for a slow hash to defend, and every refresh would otherwise
pay bcrypt's cost.

---

## 2. Authorization model

Authentication establishes *who* is calling. Authorization is separate, and
it is enforced at the resource level.

### Ownership

```
User
 └── Warehouse (ownerId)
      ├── Robots
      ├── Orders
      ├── Obstacles      (in-memory, keyed by warehouse)
      ├── Statistics
      └── Logs
```

Every resource reaches its owner through exactly one warehouse, so "may
this caller touch this object?" always reduces to "does the caller own the
warehouse it belongs to?".

`Warehouse.ownerId` is `immutable` and set from the session, never from the
request body. Child documents are **not** denormalized with an owner:
ownership is resolved through the warehouse on every request, so there is
no second copy to drift out of sync.

### Enforcement

All of it lives in `backend/src/middleware/authorize.js`. No controller
performs its own ownership check — a check that lives in twelve
controllers is a check that will be forgotten in the thirteenth.

| Helper | Used for |
|---|---|
| `requireWarehouseParam()` | routes with a warehouse `:id` |
| `requireWarehouseBody()` | creates that name a warehouse in the body |
| `requireOwnedResource(Model, label)` | a child addressed by its own id |
| `scopeListToOwner()` | collection endpoints |

### 404, not 403

A resource the caller does not own answers **404**, identical in status and
wording to one that never existed. A 403 confirms the id is real, which is
all an attacker sweeping ObjectIds needs to map the deployment. This is
tested explicitly: `authorization.test.js` asserts the two responses are
indistinguishable.

### Unfiltered lists

`GET /api/robots` with no `warehouseId` returns the caller's robots, not
every robot on the deployment. This is the quieter half of a BOLA bug and
the easier one to miss — the noisy version (`GET /api/robots/:id` for
someone else's id) gets all the attention, while the list endpoint hands
over the whole collection without anyone having to guess anything.

`Warehouse.activate()` was also cross-tenant: it deactivated *every* other
warehouse in the collection, so activating yours switched off everybody
else's. It now takes an `ownerId` and is scoped to that owner's own
warehouses; the parameter is required rather than optional so the old
behaviour cannot be re-acquired by omitting it.

---

## 3. Mass assignment

Every write path builds its payload from an explicit allow-list
(`pick()` in `backend/src/middleware/dto.js`) rather than from `req.body`.
A deny-list would be the wrong shape: it fails open every time a field is
added to a schema.

| Resource | Client may set | Server owns |
|---|---|---|
| Warehouse | `name`, `rows`, `cols`, `cells`, `schedulingStrategy` | `ownerId`, `isActive`, `_id`, timestamps |
| Robot (create) | `name`, `warehouseId`, `position`, `speed`, `battery` | `status`, `rotation`, `errorReason`, `taskQueue` |
| Robot (update) | `name`, `speed` | all physical/simulation state |
| Order (create) | `warehouseId`, `pickupLocation`, `deliveryLocation`, `priority` | `status`, `assignedRobot`, all `*At` |
| Order (update) | `pickupLocation`, `deliveryLocation`, `priority`, `status`¹ | `warehouseId`, all `*At` |
| Statistics | `warehouseId`, `metrics.*`² | `recordedAt` |
| Log | `level`, `message`, `warehouseId` | `source`, `meta` |
| User | `email`, `password`, `name` | `role`, `tokenVersion`, everything else |

¹ via the lifecycle state machine, not as a free field.
² projected key by key, so an unknown sub-key cannot ride along.

Attempting a protected field is a **422 naming the field**, not a silent
drop. A client that thinks it disabled a robot and got a 200 back is worse
off than one told where the real control is.

Notable specifics:

- **`role`** — `POST /api/auth/register` with `{"role":"admin"}` used to
  write straight through to the document.
- **`Log.source`** — a client could post entries claiming to come from
  `robot-engine`, forging the audit trail the Logs panel presents as the
  system's own account of events. It is now pinned to `client`.
- **`Statistics.recordedAt`** — backdating a snapshot drops a point into a
  period the chart has already rendered; forward-dating one skews every
  rolling average after it.
- **`Order.deliveredAt`** and friends — timestamps are facts the server
  observes, not claims the client makes.
- **`Log.meta`** — `Schema.Types.Mixed`, i.e. an unvalidated unbounded
  object straight into the database. Server-side callers use it; clients
  cannot.

### NoSQL operator injection

`{"email": {"$gt": ""}}` is valid JSON, and as a query filter it matches
the first user in the collection — an authentication bypass that never
involves a password. `mongoSanitize` strips `$`-prefixed and dotted keys
from `body`, `query`, and `params` on every request before anything builds
a filter.

---

## 4. Domain state protection

The generic CRUD endpoints are no longer a side door around the rules the
simulation engine enforces. Both now go through one shared state machine.

### Order lifecycle — `backend/src/domain/orderLifecycle.js`

```
pending ──▶ assigned ──▶ picking_up ──▶ picked_up ──▶ delivering ──▶ delivered
   │           │             │              │              │
   └───────────┴─────────────┴──────────────┴──────────────┴──▶ cancelled
```

`delivered` and `cancelled` are terminal. `assigned` and `picking_up` may
return to `pending` (an explicit un-assign — the robot broke down, or a
dispatch is being undone), which clears `assignedRobot` and `assignedAt`.

Two additional forward edges exist — `assigned → picked_up` and
`picked_up → delivering`'s shortcut `picked_up → delivered` — because the
simulation's `OrderCoordinator` observes a robot only at the moment it
*arrives* somewhere, so it advances an order a full leg at a time rather
than through the in-transit sub-states. Both are forward moves along the
same chain; `picking_up` and `delivering` remain available to API clients
driving an order by hand.

What is rejected (409 `INVALID_ORDER_TRANSITION`):

- `pending → delivered` — inventing a completed delivery no robot made,
  which every statistic derived from the orders collection then inherits
- `delivered → pending` — un-delivering a finished order
- any backwards move, and any write at all to a terminal order
- editing pickup/delivery coordinates of an order already in flight, which
  would strand the robot driving to the old ones

The engine applies the same rules **atomically**: `orderService` builds its
`bulkWrite` filters from `predecessorsOf(nextStatus)`, so a tick that was
already in flight cannot resurrect an order the client just cancelled — the
update matches no document instead of being applied and then noticed.

### Robot lifecycle — `backend/src/domain/robotLifecycle.js`

```
idle ⇄ moving        idle ⇄ charging        * → error        error → idle
```

There is deliberately no `moving → charging`: a robot must stop on a
charging cell first, mirroring `RobotEngine.startCharging`'s own guard.

`PUT /api/robots/:id` previously wrote `status` straight to Mongo, so a
client could park a moving robot in `charging` mid-aisle, revive a broken
one without clearing the fault, or set `battery: 100` on a robot that had
just run flat. The persisted document and the live engine would then
disagree — and the engine loses that argument, because it reloads from
Mongo on its next cache miss.

The fix is two-part: the state machine states the rules once for both
callers, and the REST DTO refuses to write physical state at all. Those
changes go through the endpoints that drive the engine and its own
transition rules: `POST /:id/tasks`, `/charge`, `/clear-error`, `/break`.

---

## 5. Socket.IO security

Socket.IO does not run through Express's middleware stack, so none of the
HTTP hardening applied to it. It needed its own equivalent of every layer.

| Layer | Where | What it does |
|---|---|---|
| Connection auth | `sockets/socketAuth.js` | Handshake must carry a valid access token (cookie, or `auth.token`). Uses the same `resolveUserFromToken` as REST, so the two cannot drift. |
| Room authorization | `sockets/index.js` | Joining `warehouse:<id>` requires owning it. |
| Event authorization | `sockets/index.js` | **Every** warehouse-scoped event is re-checked, not just join. |
| Payload validation | `sockets/socketValidation.js` | Types and bounds before any value reaches Mongo or the engine. |
| Rate limiting | `sockets/socketRateLimit.js` | Per socket, per event, token bucket. |

Authorizing only at join time would have left `simulation:start` wide open:
starting someone else's simulation does not require being able to see it.
Every guarded event runs rate limit → validate → authorize, in that order,
so an unauthorized caller spends its own budget before costing a database
round trip.

Denials use the same non-committal wording as the REST 404
(`error:unauthorized` / `"Warehouse not found"`), so a client cannot sweep
ObjectIds over a socket to learn which warehouses exist.

Per-event budgets (capacity / refill per second):

| Event | Capacity | Refill/s |
|---|---|---|
| `warehouse:join` / `:leave` | 20 | 1 |
| `simulation:start` / `:stop` | 10 | 0.5 |
| `simulation:tick` | 10 | 2 |
| `orders:generate` | 5 | 0.2 |
| `orders:dispatch` | 10 | 0.5 |
| anything else | 30 | 5 |

A token bucket rather than a fixed window: it absorbs the short bursts a
real UI produces (start/stop clicked a few times, rooms rejoined on
reconnect) while still bounding the sustained rate. State lives on the
socket, so it is discarded with the connection.

Also: `maxHttpBufferSize` is 64 KB (down from the 1 MB default — nothing
this API accepts over a socket is larger than a few hundred bytes), and
Socket.IO's own CORS uses the same explicit origin allow-list as Express.

---

## 6. Rate limiting

A single global limit would either be loose enough to be useless against
credential stuffing, or tight enough to break the simulation — a running
warehouse legitimately issues far more requests per minute than a human
clicking around ever would. Limits are therefore per cost class.

| Scope | Window | Max | Keyed by |
|---|---|---|---|
| `/api/auth/*` | 15 min | 10 failures | IP |
| `POST /api/auth/register` | 1 hour | 5 | IP |
| All `/api` (baseline) | 1 min | 600 | user, else IP |
| Pathfinding | 1 min | 60 | user |
| A\* **trace** mode | 1 min | 15 | user |
| Order generation | 1 min | 30 | user |
| Dispatch | 1 min | 120 | user |
| Manual tick | 1 min | 240 | user |
| Document writes | 1 min | 200 | user |

Trace mode records every step of the search and serialises it — orders of
magnitude more expensive than a plain path request in both CPU and response
size — so it gets its own much tighter budget, charged *only* to requests
that actually set `trace: true`, and stacked on top of the pathfinding
limit rather than replacing it.

Keying by user id when signed in means one abusive account cannot exhaust
the budget of everyone behind the same corporate egress IP, and that
rotating IPs does not reset an authenticated attacker's budget.

IP keys go through `ipKeyGenerator`, which collapses IPv6 to its /64
prefix. A raw IPv6 address is a terrible rate-limit key: a residential
client is routinely handed a whole /64 and can pick a fresh address per
request, resetting its budget every time.

`trust proxy` is set to exactly `1` in production. Trusting every hop
(`true`) would let a client set `X-Forwarded-For` itself and choose its own
rate-limit key.

---

## 7. CORS, headers, cookies, CSRF

### CORS

`origin` is an explicit allow-list from `CLIENT_ORIGINS` — never `true`,
never `*`, and never a reflection of `req.headers.origin`. With
`credentials: true`, a reflected-origin policy is equivalent to letting any
website make authenticated requests as a signed-in user and read the
replies. (The spec forbids `*` with credentials outright, but reflecting
the request's origin recreates the same hole while looking specific.)

In production the server **refuses to boot** if `CLIENT_ORIGINS` is unset,
rather than falling back to a permissive default.

Requests with no `Origin` header (curl, health checks) are allowed through
CORS — there is no browser to protect, and CORS is not an authentication
mechanism. `requireAuth` still applies.

### Headers

Helmet, with:

- CSP `default-src 'none'; frame-ancestors 'none'; base-uri 'none';
  form-action 'none'` — this is a JSON API serving no HTML, so the correct
  policy forbids essentially everything
- `Referrer-Policy: no-referrer`
- HSTS in production (180 days, `includeSubDomains`)
- `Cross-Origin-Resource-Policy: cross-origin` (the frontend is a separate
  origin fetching data)
- `X-Powered-By` disabled

### Cookies

| Cookie | httpOnly | Path | Purpose |
|---|---|---|---|
| `wrs_access` | yes | `/` | Access token |
| `wrs_refresh` | yes | `/api/auth` | Refresh token |
| `wrs_csrf` | **no** | `/` | Client half of the CSRF pair |

`Secure` and `SameSite` derive from `NODE_ENV`. In production the frontend
(Vercel) and API (Render) are different registrable domains, so the cookies
are cross-site and must be `SameSite=None`, which browsers only permit with
`Secure`. Locally everything is same-site through Vite's proxy, where `Lax`
is both sufficient and CSRF-safer.

`wrs_csrf` is readable by design — it is not a credential on its own. It
only proves the caller could read a cookie from our origin, which a
cross-site attacker cannot do.

### CSRF

`SameSite=None` in production means the browser attaches the session to
cross-site requests, so double-submit CSRF protection is required, not
optional. The client echoes `wrs_csrf` in an `X-CSRF-Token` header on every
state-changing request; a forged cross-site request can send the cookie but
cannot read it to produce the header.

Applied at `app.use('/api', csrfProtection)` — before the routers, so a new
route cannot forget it. It triggers on the presence of *either* auth
cookie: keying only on the access cookie would leave a gap exactly where it
hurts most, because once a 15-minute access token expires its cookie is
gone, and `POST /api/auth/refresh` — the one request that mints a whole new
session — would be the request left unprotected.

Callers presenting `Authorization: Bearer` instead of a cookie are exempt:
there is no ambient credential for a third-party site to abuse.

---

## 8. Input validation

`express-validator` on every route, plus bounds that exist for cost rather
than correctness:

- **Coordinates** are bounded `0–79` at the route *and* checked against the
  specific warehouse's `rows`/`cols` in the controller. "Non-negative" is
  not "inside this warehouse" — an out-of-bounds goal would otherwise make
  A\* explore the entire reachable grid before reporting failure.
- **`cells`** capped at 6400 entries (80×80); obstacle cells at 400.
- **`deltaSeconds`** capped at 10. The engine advances every robot by
  `speed × deltaSeconds` inside one synchronous loop, so an unbounded value
  is a single request that blocks the process.
- **`count`** (order generation) 1–100; **pagination** capped at 100 per
  page, with non-numeric and negative values falling back to defaults
  rather than producing a negative skip.
- **Metrics** individually bounded — an unbounded `deliveriesPerHour` ends
  up on a chart axis.
- **Bodies** capped at 256 KB JSON / 64 KB form.
- **Socket payloads** validated by `socketValidation.js` before reaching
  Mongo or the engine.
- **`logs?source=`** constrained to a short plain string; it reaches a
  Mongo filter, and `isString()` alone accepted objects.

---

## 9. Environment secrets

| Variable | Required | Notes |
|---|---|---|
| `MONGO_URI` | yes | Use a separate database for dev/staging |
| `JWT_ACCESS_SECRET` | **production** | ≥32 chars, distinct from the refresh secret |
| `JWT_REFRESH_SECRET` | **production** | ≥32 chars |
| `CLIENT_ORIGINS` | **production** | Comma-separated exact origins |
| `JWT_ACCESS_TTL_SECONDS` | no | Default 900 |
| `JWT_REFRESH_TTL_SECONDS` | no | Default 2592000 |
| `BCRYPT_ROUNDS` | no | Default 12 |
| `MAX_FAILED_LOGINS` | no | Default 8 |
| `LOGIN_LOCKOUT_SECONDS` | no | Default 900 |
| `COOKIE_SAMESITE` / `COOKIE_SECURE` / `COOKIE_DOMAIN` | no | Derived from `NODE_ENV` |

Generate each secret separately — they must not be the same value:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Two keys rather than one so a leaked access secret does not also let an
attacker mint refresh tokens. In production the server throws on startup if
either is missing or under 32 characters, rather than falling back to a
default that would be identical on every deployment. Outside production a
random value is generated per process, so a fresh checkout and `npm test`
work with no setup (tokens simply do not survive a restart locally).

Rotating either secret signs everyone out. That is the intended emergency
response to a suspected leak.

No secret reaches the frontend. Every `VITE_*` value is baked into the
public bundle in plain text; the session lives in cookies the browser
manages, and the app never sees a token.

---

## 10. Threat model

### In scope, and addressed

| Threat | Mitigation |
|---|---|
| Unauthenticated API/socket access | `requireAuth`, socket handshake auth |
| IDOR / BOLA across all six resource types | Ownership middleware, 404 responses |
| Cross-tenant writes and simulation control | Owner-scoped filters, per-event socket authorization |
| Object enumeration | Indistinguishable 404s, rate limits on joins and reads |
| Mass assignment / privilege escalation | Allow-list DTOs, 422 on protected fields |
| NoSQL operator injection | Global sanitisation of body/query/params |
| Invalid domain state transitions | Shared state machines, atomic predecessor filters |
| Brute force / credential stuffing | Per-IP limiter + per-account lockout |
| Credential enumeration | Uniform responses, timing equalisation |
| Session fixation | New token pair per login, unique `jti` |
| Refresh token theft | Rotation with family-wide reuse detection |
| XSS stealing the session | httpOnly cookies — an XSS is bounded by the page's lifetime rather than yielding a copyable long-lived token |
| CSRF | Double-submit token on all cookie-authenticated writes |
| Cross-origin credential abuse | Strict CORS allow-list, no wildcard with credentials |
| Resource exhaustion | Tiered rate limits, payload/body caps, bounded `deltaSeconds` |
| Information disclosure via errors | Generic 500s and 401s in production, no stack traces, truncated 404 paths |
| Audit-trail forgery | `Log.source` server-assigned |

### Out of scope

- **Email verification** — anyone can register with an address they do not
  control. There is no email infrastructure in this project.
- **Password reset** — no reset flow exists; a forgotten password means a
  new account. Adding one introduces its own token-handling surface.
- **MFA.**
- **Sharing / collaboration** — ownership is strictly one user per
  warehouse. There is no concept of a team, a viewer, or a shared
  simulation.
- **Admin tooling** — the `admin` role exists on the model and
  `requireRole` is implemented, but no route uses it. Authorization here is
  ownership-based by design.
- **Audit logging of security events** — failed logins and authorization
  denials are not persisted for review.
- **Infrastructure** — TLS termination, WAF, DDoS protection, and database
  network rules belong to Render/Vercel/Atlas, not to this code.

---

## 11. Known limitations

1. **Rate-limit state is per process.** `express-rate-limit`'s default
   memory store means limits are not shared across instances, and they
   reset on restart/redeploy. Render's free tier runs one instance, so this
   is currently accurate but would need a Redis store before scaling out.
   The same applies to the socket buckets, which are per connection by
   design.

2. **Account lockout is a denial-of-service lever.** Someone who knows a
   victim's email can keep the account locked with repeated bad passwords.
   The 15-minute window bounds it, and the per-IP limiter makes sustaining
   it expensive, but it is a real trade-off — the alternative (no lockout)
   is worse.

3. **Simulation engines are cached per warehouse in process memory.** The
   cache is keyed by warehouse id and populated only through
   ownership-checked entry points, so it is not a cross-tenant read path,
   but it is unbounded in the number of warehouses ever touched since
   restart.

4. **In-memory obstacles are not persisted.** They live in the engine, so
   they are lost on restart and are not covered by database-level access
   control — only by the ownership check on the routes that reach them.

5. **No CSP on the frontend.** The API sends a strict CSP, but it serves no
   HTML. The Vercel-hosted frontend has no CSP header of its own; adding
   one is a hosting-configuration change outside this codebase.

6. **`GET /api/health` is public** and reports uptime and database
   connection state. This is deliberate — Render's health checks need it —
   but it is a small unauthenticated information disclosure.

7. **Refresh rotation is not transactional.** Issuing the successor and
   revoking the predecessor are two writes. A crash between them leaves a
   valid successor and an unrevoked predecessor; the next use of the
   predecessor is then treated as reuse and kills the family, which fails
   safe (an unnecessary sign-out) rather than open.

8. **Warehouses created before this phase have no owner** and are invisible
   to the API until backfilled. See below.

---

## 12. Deployment notes

### Existing data

`Warehouse.ownerId` is required. Documents written before this phase have
none, so they match no ownership query — invisible to every user, and not
readable, editable, or deletable through the API. Nothing is lost; the
documents are untouched.

To adopt them, register an account, then:

```bash
cd backend
node scripts/backfill-ownership.js --email you@example.com          # dry run
node scripts/backfill-ownership.js --email you@example.com --apply
```

The script only ever sets `ownerId` on documents that have none. It never
reassigns an owned warehouse, never touches robots/orders/statistics/logs
(they inherit ownership through the warehouse), and never deletes or
restructures anything. Take a database snapshot before `--apply` anyway.

### New environment variables

Set on the backend service (Render) **before** deploying, or startup will
throw:

```
JWT_ACCESS_SECRET=<48 random bytes, base64url>
JWT_REFRESH_SECRET=<a different 48 random bytes>
CLIENT_ORIGINS=https://your-frontend.vercel.app
```

`CLIENT_ORIGINS` must be the exact deployed origin — scheme, host, port, no
trailing slash or path. A mismatch here does not fail loudly on the server;
it shows up as every browser request being blocked.

If Vercel preview deployments need to reach the API, each preview origin
must be listed too (they get distinct hostnames).

### Behaviour changes to expect

- Every API route except `/api/health` now returns 401 without a session.
  Any external script or integration calling this API needs credentials.
- The frontend shows a sign-in screen before the dashboard.
- Socket.IO rejects unauthenticated handshakes, so any client connecting
  without cookies will fail to connect rather than silently receiving
  nothing.
- `PUT /api/robots/:id` no longer accepts `status`, `battery`, `position`,
  or `rotation` (422). Use `/tasks`, `/charge`, `/clear-error`, `/break`.
- `POST /api/orders` no longer accepts `status` or `assignedRobot` (422).
- `POST /api/logs` requires `warehouseId` and rejects `source` and `meta`.
- Illegal order status transitions return 409 instead of being applied.

### Verification

```bash
cd backend  && npm test          # 434 tests, incl. 165 security tests
cd frontend && npm run build
```

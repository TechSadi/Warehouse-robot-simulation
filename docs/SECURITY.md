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
| `POST` | `/api/auth/password/forgot` | Start a password reset |
| `POST` | `/api/auth/password/reset` | Complete one, with the emailed token |
| `POST` | `/api/auth/password/change` | Change it while signed in |
| `POST` | `/api/auth/email/verify/request` | Send a confirmation link |
| `POST` | `/api/auth/email/verify` | Confirm, with the emailed token |
| `POST` | `/api/auth/mfa/setup` | Generate a TOTP secret and QR URI |
| `POST` | `/api/auth/mfa/enable` | Confirm enrolment, receive recovery codes |
| `POST` | `/api/auth/mfa/disable` | Turn it off (password **and** a factor) |

Four of these are unauthenticated by necessity, and each for a specific
reason worth stating:

- `password/forgot` and `password/reset` — the whole point is that the
  caller cannot sign in. Both answer identically whether or not the address
  has an account, because a "we couldn't find that email" would make them a
  cleaner account-existence oracle than the login form, which goes to real
  trouble not to be one.
- `email/verify` — the link is followed from an email client, which is
  frequently not the browser holding the session. The token is the
  credential.
- `refresh` — establishing a session is what it is for.

All four carry the strict `accountRecoveryLimiter` on top of the ordinary
auth limiter.

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
- Per-account **per source network**: 8 consecutive failures from one
  source locks *that source* out of the account for 15 minutes, and the
  lock holds even against the correct password — otherwise it would not
  slow an attacker down at all.

The per-source part is a correction, not a detail. A single account-wide
counter made lockout a denial-of-service lever: anyone who knew a victim's
email could keep the account locked indefinitely with a stream of wrong
passwords, and the victim could not sign in from anywhere. Bucketing by
source keeps the defence pointed at the attack — the guessing source is
locked out, and the real user, coming from somewhere else, is unaffected.

The trade is explicit: an attacker with many source addresses now gets more
attempts against one account than before. What bounds that is the per-IP
limiter above, which is the control actually suited to a distributed
attack, and `User.globalFailedLogins`, which counts every failure from
anywhere so the *pattern* is recorded even though it is not acted on. The
bucket list is capped (`MAX_LOGIN_FAILURE_BUCKETS`) so rotating addresses
cannot grow one user document without limit.

**Second factor.** When MFA is enabled, a correct password alone answers
`401` with `code: MFA_REQUIRED`. That is deliberately *not* the vague
"invalid email or password": the caller has already proven the password, so
there is nothing left to enumerate, and being vague would only confuse a
legitimate user. A TOTP code is refused if its step has already been
accepted (`MFA_REPLAY`), so a code captured by a phishing page and relayed
does not work twice.

**Password reset flooding.** `accountRecoveryLimiter` is tighter than the
auth limiter and on a longer window (10 per hour per IP), because a reset
request sends mail to an address the caller named — an unlimited one is
both an enumeration oracle and a way to use this service to spam a third
party. Each request also supersedes the previous token, so a flood is a
denial of service against a user genuinely trying to recover an account.

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
this caller touch this object?" always reduces to "how far does the caller
reach into the warehouse it belongs to?".

`Warehouse.ownerId` is `immutable` and set from the session, never from the
request body. Child documents are **not** denormalized with an owner:
access is resolved through the warehouse on every request, so there is no
second copy to drift out of sync.

### Three levels, not two

Ownership used to be the whole of the model — one user per warehouse, no
team, no viewer, no shared simulation — and the workaround that forced was
"send them your password". Warehouses can now carry `collaborators`, so the
answer is no longer yes/no:

| Level | May |
|---|---|
| `view` | Read everything, and watch the live simulation |
| `edit` | ...and change what is *in* it: robots, orders, obstacles, ticking, starting and stopping |
| `own` | ...and change whether it exists, what shape it is, and who else can reach it |

Each level includes the ones below. The level a route needs is **named at
the route**, not inferred from the HTTP verb, because the verb is the wrong
signal here: `POST /:id/tick` is a write in every sense that matters, and
`PUT /:id` — which can change the layout, reloading the engine and
requeueing in-flight orders — is a different kind of act from
`POST /:id/orders/generate`.

Three deliberate absences:

- **There is no `owner` role to grant.** The owner is `ownerId`, it is
  immutable, and no amount of sharing can produce a warehouse with two
  people who can each remove the other.
- **A viewer cannot start or stop the simulation.** A viewer is an
  audience, and a simulation running is a change to what everyone else in
  the room is watching.
- **An editor cannot share onward or remove anyone**, including the owner.
  Otherwise the first person you shared with could lock you out of your own
  warehouse.

### Enforcement

All of it lives in `backend/src/middleware/authorize.js`. No controller
performs its own ownership check — a check that lives in twelve
controllers is a check that will be forgotten in the thirteenth.

| Helper | Used for |
|---|---|
| `requireWarehouseParam(param, { access })` | routes with a warehouse `:id` |
| `requireWarehouseBody(field, { access })` | creates that name a warehouse in the body |
| `requireOwnedResource(Model, label, { access })` | a child addressed by its own id |
| `scopeListToOwner({ access })` | collection endpoints |
| `findAccessibleWarehouse(id, userId, access)` | the Socket.IO layer, which answers in its own vocabulary rather than by throwing |

Every one of them funnels into `loadAccessibleWarehouse`, which runs one
query — `{ _id, $or: [{ ownerId }, { 'collaborators.userId' }] }` — and
compares the level it finds against the level the route asked for. One
query, one comparison, one place to get it wrong.

### 404, not 403 — and when 403 *is* right

A resource the caller cannot reach **at all** answers **404**, identical in
status and wording to one that never existed. A 403 there would confirm the
id is real, which is all an attacker sweeping ObjectIds needs to map the
deployment. This is tested explicitly: `authorization.test.js` asserts the
two responses are indistinguishable.

A caller who *can* reach it but not far enough — a viewer on a shared
warehouse reaching for something only an editor may do — gets **403**, with
the level required and the level granted. At that point there is nothing
left to conceal: they already know the warehouse exists, they can already
read it, and "you may look but not touch" is genuinely useful to be told
rather than a leak. Denials of this kind are recorded in the audit trail.

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
| Password reset / verification / MFA changes | 1 hour | 10 | IP |
| Client error reports | 1 min | 20 | user |
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

### Where the counters live

`express-rate-limit`'s default memory store is per process: limits are not
shared across instances and reset on every restart and redeploy. That was
accurate-but-fragile on a single free-tier instance and simply wrong the
moment there are two — an attacker gets one full budget per instance, and
any deploy hands out fresh budgets to everyone.

`RATE_LIMIT_STORE=mongo`, the production default, keeps them in the
database this application already has
(`middleware/rateLimitStore.js`). Mongo rather than Redis because a rate
limiter is not worth an extra piece of infrastructure to run, monitor and
pay for; the trade is a round trip per limited request, which Redis would
not charge. Each limiter gets its own key prefix, so two limiters that both
key by IP cannot share a counter and silently enforce the tighter of the
two on both.

The socket buckets remain per connection by design — they bound what one
socket can push, and a socket is by definition attached to one process.

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

### The frontend's own headers

The API's CSP governs the API, which serves no HTML — so until recently the
policy that actually governs *the dashboard* did not exist anywhere. That
was recorded as a hosting-configuration change outside the codebase, which
was true of the header and not of the policy: `connect-src` has to name
whichever API origin a given build was pointed at, and only the build knows
that.

`frontend/scripts/securityHeaders.js` generates it from `VITE_API_URL` at
build time and emits it three ways, because the deployment targets disagree
about how to be configured:

| Output | Read by | Carries |
|---|---|---|
| `<meta http-equiv>` in `index.html` | any static host, no configuration | everything except the header-only directives |
| `dist/_headers` | Netlify, Cloudflare Pages | the full set |
| `dist/vercel.json` | Vercel | the full set |

The meta tag is what makes the policy real *by default* rather than by
someone remembering to wire something up; the header files exist because
`frame-ancestors`, `report-uri` and `sandbox` are header-only by
specification. Clickjacking protection therefore comes from
`X-Frame-Options: DENY` as well.

The policy allows no inline or evaluated script — nothing in the app
evaluates strings as code, and leaving both out makes a whole class of
injection unexploitable rather than merely difficult. `'unsafe-inline'` is
granted for **styles only**, which Vite and recharts both require; style
injection is defacement rather than code execution, so it is a materially
smaller concession than the script equivalent, which is not made.

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

So are five endpoints whose authority is *not* the session cookie, listed
as `CREDENTIAL_BEARING_PATHS` in `middleware/csrf.js`:

| Exempt | Why |
| --- | --- |
| `POST /api/auth/register` | Establishes a session; the cookie in the jar has no bearing on it |
| `POST /api/auth/login` | The password is the credential |
| `POST /api/auth/password/forgot` | Unauthenticated by necessity |
| `POST /api/auth/password/reset` | The emailed token is the credential |
| `POST /api/auth/email/verify` | The emailed token is the credential |

The exemption exists because gating these on cookie *presence* wedged the
application shut. Auth cookies outlive the sessions they belong to — 15
minutes for the access cookie, 30 days for the refresh cookie — and a
session can be revoked or rotated out from under them at any time. A
browser sitting on a stale pair was refused by every endpoint that could
have recovered it: registering, signing in, and all three recovery flows
answered 403 before they even validated the body, and the only remedy was
to clear cookies by hand in developer tools. Cross-origin the page could
not clear them either, since they belong to the API's origin. Signing in
overwrites the stale cookies, so the state now clears itself.

The exemption is an exact-match set, not a prefix test — `POST
/api/auth/email/verify/request` is authenticated and stays protected —
and it is matched against the full path rather than `req.path`, which is
relative to wherever the middleware was mounted.

The trade-off is login CSRF: an attacker can now cause a signed-in
victim's browser to be logged into an account the attacker controls, so
that the victim's subsequent work is recorded there. That was previously
blocked for a victim who held cookies and allowed for one who did not,
which is not a defence so much as an accident of the cookie check.
Defending it properly needs a pre-session token issued to the sign-in form
itself; that is not implemented, and is listed in §11.

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
| `MAX_FAILED_LOGINS` | no | Default 8, counted per source network |
| `LOGIN_LOCKOUT_SECONDS` | no | Default 900 |
| `MAX_LOGIN_FAILURE_BUCKETS` | no | Default 20 — bounds the per-source list on one account |
| `COOKIE_SAMESITE` / `COOKIE_SECURE` / `COOKIE_DOMAIN` | no | Derived from `NODE_ENV` |
| `RATE_LIMIT_STORE` | no | `mongo` in production, `memory` elsewhere |
| `MAIL_TRANSPORT` | **production, in practice** | `console` / `webhook` / `none`. Defaults to `none` in production, so reset and verification links go nowhere until this is set deliberately |
| `MAIL_WEBHOOK_URL` / `MAIL_WEBHOOK_TOKEN` | with `webhook` | Where outbound mail is POSTed |
| `APP_BASE_URL` | no | Where emailed links point; defaults to the first `CLIENT_ORIGINS` entry |
| `PASSWORD_RESET_TTL_SECONDS` | no | Default 1800 — a reset token is a live credential |
| `EMAIL_VERIFICATION_TTL_SECONDS` | no | Default 86400 — a verification token is not |
| `REQUIRE_EMAIL_VERIFICATION` | no | Default `false`; turning it on without a working transport locks everyone out |
| `TOTP_WINDOW` | no | Default 1 step (±30s) of clock drift |
| `MFA_RECOVERY_CODE_COUNT` | no | Default 10 |
| `SIMULATION_LEASES` | no | On outside tests — one instance owns a warehouse's tick loop |

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
manages, and the app never sees a token. `VITE_API_URL` is the one
`VITE_*` value that matters to security, and only because the generated CSP
is built from it — it is a public origin, not a secret.

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
| Audit-trail forgery | `Log.source` server-assigned; `SecurityEvent` is server-authored and has no write route at all |
| Password-reset token theft or replay | Single-use via an atomic consume, short-lived, superseded on reissue, bound to the address it was issued for, and completing one revokes every session |
| Stolen second factor | TOTP codes are refused for a step already accepted, so a shoulder-surfed or relayed code cannot be used twice |
| A collaborator escalating on a shared warehouse | Sharing, reshaping and deleting all require ownership; an editor can change what is *in* a warehouse and never who can reach it |

### Out of scope

- **Infrastructure** — TLS termination, WAF, DDoS protection, and database
  network rules belong to Render/Vercel/Atlas, not to this code.
- **Federated identity** — no OAuth, no SSO, no directory integration. One
  password and one optional second factor per account.
- **Session-level device management** — a user can end *all* sessions, and
  an admin can end another user's, but there is no per-device list to
  revoke one from.
- **Data export / erasure workflows** — deleting a warehouse cascades to
  its contents, and deleting an account is not implemented.

Six things that used to be on this list are not any more:

| Was out of scope | Now |
|---|---|
| Email verification | `POST /auth/email/verify/request` and `/auth/email/verify`, with single-use expiring tokens. Enforcement is opt-in (`REQUIRE_EMAIL_VERIFICATION`) so turning it on without a mail transport cannot lock everyone out |
| Password reset | `POST /auth/password/forgot` and `/auth/password/reset`. Delivery is a transport seam (`services/mailer.js`), which is the part that was genuinely missing; the token handling is the part that mattered |
| MFA | RFC 6238 TOTP on `node:crypto`, two-step enrolment, bcrypt-hashed recovery codes, replay refused within a code's own window |
| Sharing / collaboration | `viewer` / `editor` collaborators per warehouse, with the required level named per route and per socket event (§ 2) |
| Admin tooling | `/api/admin`, gated by `requireRole('admin')`: read the audit trail, see account state, revoke sessions. Deliberately no impersonation and no ownership bypass |
| Audit logging of security events | The `SecurityEvent` collection, written by `services/securityAudit.js` and read at `/api/admin/security-events` |

---

## 11. Known limitations

1. **Lockout is per source network, which widens the guess space.**
   Counting failures per account made lockout a denial-of-service lever:
   anyone who knew a victim's email could keep them out of their own
   account. Counting per source network (`loginFailures` in `User.js`)
   fixes that, and the cost is explicit — an attacker with many source
   addresses now gets more attempts against one account than before. What
   bounds that is the per-IP rate limiter, which is the control actually
   suited to a distributed attack, and `globalFailedLogins`, which records
   the pattern for the audit trail without acting on it.

2. **Mail delivery is a transport, and the default transport is not
   delivery.** Outside production `MAIL_TRANSPORT=console` writes reset and
   verification links to the server log, which makes the flows usable and
   testable on a laptop. Production defaults to `none` rather than to
   `console` — a link printed to a log nobody reads is not a delivered
   email, and inheriting `console` would mean shipping a password reset
   that silently does not work. A real deployment must set
   `MAIL_TRANSPORT=webhook` and point it somewhere.

3. **Recovery codes are the only MFA fallback.** Lose the authenticator and
   the codes, and an administrator revoking sessions does not help — there
   is no identity-proofing path back into an account. That is the correct
   trade for a project with no support desk, but it is a real way to lose
   an account permanently.

4. **The audit trail is written, read, and never acted on.** Failed logins,
   lockouts, refresh reuse and authorization denials are recorded and
   readable at `/api/admin/security-events`. Nothing alerts on them: there
   is no threshold, no notification, no automatic response. It supports an
   investigation; it does not start one.

5. **Rate-limit counters cost a round trip when shared.**
   `RATE_LIMIT_STORE=mongo` (the production default) puts them in the
   database this app already has, so limits hold across instances and
   survive a redeploy. Mongo rather than Redis because a rate limiter is
   not worth an extra piece of infrastructure to run and pay for; the trade
   is a database round trip per limited request, which Redis would not
   charge.

6. **Simulation engines are still cached in process memory.** Bounded now —
   by idle TTL and an LRU ceiling, with actively-ticking warehouses pinned
   — so it is no longer unbounded in the number of warehouses ever touched.
   It remains per process, and it remains a cache of documents the caller
   was already authorized to read.

7. **The frontend CSP is generated, not audited.** It is built from
   `VITE_API_URL` and emitted as a meta tag plus `_headers` and
   `vercel.json`, so a deployment gets a real policy by default. It still
   carries `'unsafe-inline'` for styles, which Vite and recharts both need;
   script sources take no such concession.

8. **`GET /api/health` is public**, and now reports only that the process
   is serving requests. The uptime and database state that used to be there
   moved to `/api/health/details` behind a session.

9. **Login CSRF is not defended.** The endpoints that carry their own
   credential are exempt from the double-submit check (§7), so an attacker
   can cause a victim's browser to be signed into an account the attacker
   controls and collect whatever the victim then does in it. The previous
   behaviour was not a defence either — it blocked this only for a victim
   who happened to be holding auth cookies, while wedging every stale-cookie
   browser out of the application entirely. Defending it properly needs a
   pre-session token issued to the sign-in form itself, which is not
   implemented.

10. **Warehouses created before the security phase have no owner** and are
   invisible to the API until backfilled. See below.

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

Two more that do not throw on startup but do silently disable a feature:

```
MAIL_TRANSPORT=webhook                    # else password reset delivers nowhere
MAIL_WEBHOOK_URL=https://...              # where outbound mail is POSTed
APP_BASE_URL=https://your-frontend...     # where the emailed links point
```

Production defaults `MAIL_TRANSPORT` to `none` rather than to `console`,
deliberately: a reset link written to a log nobody reads is not a delivered
email, and inheriting the development default would mean shipping a
password reset that appears to work and does not.

On the **frontend** build, `VITE_API_URL` now does one more job: the
generated Content-Security-Policy is built from it (§ 7). Getting it wrong
no longer only breaks the API calls — it produces a policy that blocks
them.

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
- `GET /api/health` reports only `{ service, status }`. Uptime and database
  state moved to `GET /api/health/details`, which requires a session. A
  platform health check that only needs a 200 is unaffected.
- Accounts start unverified. Nothing enforces verification unless
  `REQUIRE_EMAIL_VERIFICATION=true`, but `emailVerified` is reported on
  `/api/auth/me` from the start.
- `POST /api/auth/login` may answer 401 with `code: MFA_REQUIRED` for
  accounts that have enrolled a second factor. A client that treats every
  401 as "wrong password" will be confusing to those users.
- Listing warehouses now returns those **shared with** the caller as well
  as their own, each carrying an `access` field of `view`/`edit`/`own`.
- A second backend instance will decline to tick a warehouse the first
  already holds (`SIMULATION_LEASES`), reporting `blockedBy` in
  `simulation:status` rather than running a second simulation of it.

### Verification

```bash
cd backend  && npm test          # 655 tests, incl. 257 security tests
cd frontend && npm run verify    # lint, typecheck, 401 tests, production build
```

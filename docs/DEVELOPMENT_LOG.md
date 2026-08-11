# Development Log

This project was built incrementally, one milestone at a time, following
the development plan in the original project brief. Each section below is
the "what this milestone added, and how it was verified" note written at
the time that milestone was completed - kept in full because it's the most
accurate record of *why* the codebase looks the way it does: which
decisions were deliberate trade-offs, which limitations were known and
accepted, and which gaps got caught and fixed by a later milestone.

For the current state of the finished project, see [`README.md`](../README.md)
and the rest of the [`docs/`](.) folder. This file is history, not a guide
to using the app.

---

## What Milestone 1 delivered

- A running Express API with Helmet, Morgan, CORS, compression, centralized
  error handling, and an MVC folder layout
- A Socket.IO server attached to the same HTTP server, logging connect/disconnect
- A React + Vite dashboard shell: responsive top nav, sidebar, a
  blueprint-styled simulation canvas frame, and a control/statistics rail
- End-to-end connectivity: the frontend's connection status pill reflects a
  real health check and socket handshake against the backend

## What Milestone 2 adds

A fully interactive warehouse grid, rendered on `<canvas>` for smooth
zoom/pan performance even at larger grid sizes:

- **Grid engine** (`src/engine/grid/`) — pure, framework-agnostic functions
  for creating, resizing, reading/writing cells, and serializing a grid.
  Storage is sparse (only non-empty cells are kept), so resizing and export
  stay cheap regardless of grid size.
- **Dynamic generation & resizing** — set rows/cols (5–80 each) from the
  Simulation Controls panel; existing cells that still fall in bounds are
  preserved.
- **Zoom & pan** — mouse wheel zooms centered on the cursor; drag to pan
  (or hold Space to force-pan even with a placement tool active); +/− and
  Reset View buttons are also available for non-wheel input.
- **Cell types** — Shelf, Charging Station, Obstacle, Dock, each with a
  `walkable` flag already in its definition for the A* and robot-movement
  milestones to use later.
- **Object placement & deletion** — pick a tool from the sidebar palette,
  then click or click-drag to paint; right-click always erases regardless
  of the active tool.
- **Cell selection** — the Select tool shows a cell's coordinates and type
  in the Selected Cell inspector.
- **Grid serialization** — Export JSON downloads the current layout;
  Import JSON loads one back in, with full validation (out-of-range or
  malformed cells are dropped rather than crashing the app).
- Fleet Statistics now shows real grid numbers (size, occupied cells,
  shelves, obstacles) alongside the still-pending robot/order stats.

Tested with an automated Playwright pass covering placement, drag-paint,
right-click erase, selection, zoom, resize, and an export→clear→import
round-trip — all verified working end-to-end.

## What Milestone 3 adds

Persistence for everything the grid engine and (eventually) the simulation
produce, via five Mongoose collections and a REST API in front of them.

**Collections**

| Model        | Purpose                                                      | CRUD          |
|--------------|---------------------------------------------------------------|---------------|
| `Warehouse`  | A saved grid layout (matches the frontend's export/import JSON shape) | Full + `PATCH /:id/activate` |
| `Robot`      | Position, battery, speed, rotation, status, task queue         | Full          |
| `Order`      | Pickup/delivery locations, status, priority, assigned robot     | Full          |
| `Statistics` | Point-in-time fleet metric snapshots                          | Create/Read/Delete only |
| `Log`        | System/simulation event log                                    | Create/Read/Delete only |

Statistics and Logs are deliberately **append-only** — there's no update
endpoint for either, since editing a historical snapshot or log entry
doesn't make sense. Attempting `PUT` on either returns a 404, same as any
other undefined route.

**Validation** runs in two layers: `express-validator` checks the request
shape at the route (missing fields, wrong types, out-of-range numbers,
invalid enum values, malformed Mongo IDs) before anything touches the
database, and each Mongoose schema enforces the same constraints again at
the data layer as a second line of defense. The error handler now also
translates Mongoose's own `CastError`, `ValidationError`, and duplicate-key
errors into the same `{ message, details }` response shape as everything
else, so API consumers never need to special-case where an error came from.

**API testing**: `backend/tests/` has 39 Jest + Supertest tests covering
every resource's CRUD paths, request validation, and error formatting.
Since this sandbox can't reach MongoDB's binary download servers (no
`mongodb-memory-server`, no Docker/`mongod` available), the database layer
is mocked at the model boundary rather than run against a live database —
each test asserts the controller called the right Mongoose method with the
right arguments and that the response is shaped correctly, while
`health.test.js` and `validation.test.js` run against the real app for the
parts that don't need a database at all. Wiring these same tests up to a
real MongoDB (via `mongodb-memory-server` or a Postgres-style test
container) is straightforward once this runs somewhere with unrestricted
network access, and is worth doing in Milestone 15's CI setup.

## What Milestone 4 adds

An A* pathfinding engine built entirely from scratch (`backend/src/engine/pathfinding/`)
— no external pathfinding libraries:

- **Priority queue** — a hand-written binary min-heap (`priorityQueue.js`),
  O(log n) push/pop. A*'s open set uses it directly; cost updates use the
  standard lazy-deletion pattern (push a new entry, skip stale ones on pop)
  rather than a decrease-key operation.
- **Open set / closed set / parent tracking** — the open set is the
  priority queue plus a `gScore` map for O(1) best-known-cost lookups; the
  closed set is a plain `Set` of finalized cells; `cameFrom` is a map used
  to walk back from goal to start once the path is found.
- **g / h / f costs** — `g` is the real cost from start to a node, `h` is
  the heuristic estimate to the goal, `f = g + h` is what the priority
  queue orders by.
- **Three heuristics** (`heuristics.js`), selectable per call:
  - `manhattan` — exact for 4-directional movement
  - `euclidean` — straight-line distance, admissible either way
  - `diagonal` — octile distance, exact for 8-directional movement
- **Diagonal movement** is opt-in (`allowDiagonal: true`) and includes
  corner-cutting prevention — a diagonal step is refused if both of the
  orthogonal cells it would cut across are blocked, a common A*
  correctness bug on grids with walls.
- **Reusable by design** — `findPath(grid, start, goal, options)` takes
  only a plain `{ rows, cols, isBlocked(x, y) }` interface, has no shared
  state between calls, and doesn't know or care that a "robot" exists.
  `warehouseToGrid()` adapts a Warehouse document into that interface.
  Multiple robots can call it concurrently against the same warehouse with
  no cross-talk (there's a test for exactly this).
- **Built for the visualization milestone already** — the engine is
  actually a generator (`astarSteps`) that yields a snapshot (current node,
  open set size, closed set contents) after every expansion; `findPath` is
  just a thin wrapper that drains it. Milestone 12 (AI Visualisation Panel)
  can consume `astarSteps` directly to animate the search instead of the
  engine needing to be reworked later.
- **A real integration point, not just a library sitting unused**:
  `POST /api/warehouses/:id/path` runs the engine against a saved layout
  and returns the result — useful for testing now, and the same `findPath`
  call Milestone 5's robot engine will make directly.

**Tested thoroughly**: 44 new tests (83 total across the backend) covering
the priority queue (ordering, duplicates, a 2000-item stress test), all
three heuristics (including admissibility checks), and the A* engine
itself — straight paths, routing around walls, unreachable goals, blocked
start/goal, diagonal movement, corner-cutting prevention, and a large
(50×50) grid for performance sanity. Critically, A*'s optimality isn't
just asserted — it's cross-checked against an independent brute-force BFS
shortest-path implementation written directly in the test file, across
several obstacle layouts, for all three heuristics.

## What Milestone 5 adds

A Robot Engine (`backend/src/engine/robots/robotEngine.js`) that actually
moves robots, not just stores their position:

- **Spawn / remove** — `spawnRobot()` / `removeRobot()`, rejecting a spawn
  on a blocked cell or a duplicate id.
- **Smooth movement** — positions are fractional and advance by
  `speed * deltaSeconds` each `tick()`, interpolating continuously along
  the A* path rather than jumping cell-to-cell. A single tick can cross
  multiple waypoints (and even finish one task and start the next) if the
  distance budget allows, so simulation speed isn't tied to tick frequency.
- **Robot state machine** — `idle → moving → idle`, plus `charging` and
  `error`, with real transition rules (e.g. you can't start charging while
  moving, and an unreachable destination goes straight to `error` with a
  human-readable `errorReason`).
- **Battery** — drains proportionally to distance actually traveled
  (not planned distance), and running out mid-path stops the robot exactly
  where it is and puts it in `error` - with the interrupted destination
  preserved so it resumes automatically once recharged.
- **Speed & rotation** — speed is per-robot (from the existing schema
  field); rotation is computed from the actual heading of travel each step.
- **Task queue** — `assignTask()` queues a destination; an idle robot
  starts immediately, a busy one picks it up automatically when it becomes
  idle again (path complete, or charging finishes at 100%).
- **Reusable across robots** — one `RobotEngine` instance manages every
  robot in a warehouse via a single `Map`, with no shared mutable state
  between them beyond the read-only grid; there's a test proving several
  robots tick independently with zero cross-contamination.
- **Built on Milestone 4, not parallel to it** — `assignTask` calls
  `findPath` directly. No separate pathfinding logic was written for robots.

**A real design correction from Milestone 2**: charging stations were
originally marked non-walkable, same as shelves and obstacles. Building
the charging state machine surfaced the problem immediately - a robot has
to be able to *stand on* a charging station to use it, the same way it
already could stand on a dock. Fixed in both the frontend and backend cell
type definitions (`walkable: true` for `charging`), with tests updated to
match. Shelves and obstacles are still solid.

**REST integration** (`services/simulationManager.js` bridges the pure
engine to MongoDB, lazily loading a warehouse's robots into a live engine
on first use):
- `POST /api/robots/:id/tasks` `{ destination: { x, y } }`
- `POST /api/robots/:id/charge`
- `POST /api/robots/:id/clear-error`
- `POST /api/warehouses/:id/tick` `{ deltaSeconds }` - advances that
  warehouse's whole simulation and persists every robot that changed

Only physical state (position, rotation, battery, status, errorReason) is
persisted to MongoDB - the engine's in-memory task queue is intentionally
not, since `Robot.taskQueue` in the schema is reserved for Order Management
(Milestone 6) to assign real orders rather than raw coordinates. A real
interval-driven simulation loop broadcasting over Socket.IO is Milestone
11's job; `tick()` is the exact call it will end up making, just triggered
by a request for now instead of a timer.

**Tested thoroughly, and it caught real bugs**: 43 new tests (127 total).
The 29 pure-engine tests (no mocks, no DB, no real timers) initially caught
two genuine bugs during this milestone - a robot that finished its path
with exactly zero distance budget left over stayed stuck in `moving`
forever, and a task that failed to find a path was silently dropped instead
of staying retryable via `clearError()`. Both are fixed and now have
regression tests. REST-layer tests mock `simulationManager` directly
(the engine logic is already proven) and check routing, validation, and
that every `RobotEngineError` code maps to the right HTTP status.

## What Milestone 6 adds

Orders now actually move through their lifecycle instead of just sitting
in the database as status strings.

- **Order generation** (`engine/orders/orderGenerator.js`, pure) — random
  pickup/delivery pairs against a real warehouse layout: pickup from any
  open floor cell, delivery preferring dock cells (falling back to any
  walkable cell if the layout has none), with a weighted priority mix
  (mostly `normal`, `urgent` deliberately rare). `POST
  /api/warehouses/:id/orders/generate` `{ count }` persists the result.
- **Pickup → delivery chaining** (`engine/orders/orderCoordinator.js`,
  pure) — the missing link between "Order" and the Robot Engine's plain
  `{x, y}` task queue from Milestone 5. It tracks which order each robot is
  currently fulfilling and which leg it's on, and automatically starts the
  delivery leg the moment a robot arrives at pickup - all via direct calls
  into `RobotEngine`, no database involved, so it's exactly as unit-testable
  as the layer below it.
- **Order assignment** (`services/orderService.js`) — `dispatchPendingOrders()`
  assigns pending orders to free idle robots, highest priority first
  (ties broken by age), each paired with its nearest available robot. This
  is deliberately **one simple default strategy**, not the full pluggable
  system - Milestone 7 (Robot Scheduling) is where FCFS / nearest-robot /
  least-busy / round-robin / priority-queue become selectable options.
- **Order priorities now do something** - `urgent` orders get dispatched
  before `normal` ones sitting in the same pending queue, not just stored
  as a label.
- **Pickup, delivery, and completion** — `POST /api/warehouses/:id/tick`
  now runs a full simulation step: move robots → detect arrivals →
  advance the corresponding order (`pending → assigned` on dispatch,
  `assigned → picked_up` on pickup arrival, `picked_up → delivered` on
  delivery arrival) → log any robot that just entered an error state → try
  to dispatch newly-freed robots onto any still-pending orders. Manual
  `POST /api/warehouses/:id/orders/dispatch` is also available outside of
  ticking, for testing or triggering assignment on demand.
- **The Log collection is finally used for something real** — a robot
  entering the error state, or a delivery becoming unreachable mid-route,
  now writes an actual `Log` entry instead of that collection sitting
  empty since Milestone 3.

**A design correction, this time caught by the tests themselves rather
than by hand-tracing**: `OrderCoordinator.processTick()` originally only
handled the case where starting a delivery leg returned an `error`-status
snapshot. My own test for an unreachable delivery point accidentally
blocked the delivery cell *itself* rather than just enclosing it - which
took a different code path and threw synchronously instead. Fixing the
test also exposed the real gap: one malformed delivery destination could
have thrown out of `processTick` and broken every other robot being
processed in that same tick. Fixed with a `try/catch` so one bad order
can't take down the batch.

**Tested thoroughly**: 27 new tests (150 total). The generator and
coordinator are tested exactly like the A* and Robot engines before them -
pure, no mocks, no database - including a deterministic-rng test proving
the priority weighting boundaries exactly, and a multi-robot test proving
two robots complete two different orders independently in the same run.
REST-layer tests mock `orderService` directly and check the tick
endpoint's full orchestration (order events processed, newly-freed robots
dispatched, errors logged) end to end.

## What Milestone 7 adds

The single hardcoded assignment policy from Milestone 6 is now 5
selectable strategies, switchable from the UI.

- **`engine/scheduling/strategies.js`** (pure, no mocks needed) - built as
  two composable pieces rather than 5 separate implementations:
  - **Order selectors**: `fcfs` (oldest order first, priority ignored) and
    `priority` (urgent first, ties broken by age)
  - **Robot selectors**: `firstAvailable`, `nearest` (closest to pickup),
    `leastBusy` (fewest orders completed this session - spreads work
    across the fleet), and `roundRobin` (cycles through the full roster in
    a stable order, correctly skipping busy robots without losing its
    place)
  - The 5 named strategies are just pairings of these:

    | Strategy | Order selection | Robot selection |
    |---|---|---|
    | First Come First Serve | fcfs | firstAvailable |
    | Nearest Robot | fcfs | nearest |
    | Least Busy Robot | fcfs | leastBusy |
    | Round Robin | fcfs | roundRobin |
    | Priority Queue | priority | nearest |

- **`Warehouse.schedulingStrategy`** - a new field (enum of the 5 keys,
  default `nearest_robot`) using the existing `PUT /api/warehouses/:id`
  endpoint - no new backend route needed to switch it.
- **Stateful strategies get externalized, injectable state** - round
  robin's cursor and least-busy's completed-order counts live in
  `simulationManager.getSchedulerState(warehouseId)`, the same caching
  pattern already used for engines and order coordinators, not hidden
  module-level globals. `orderService.processTickEvents` updates the
  completed count on every delivery.
- **Frontend: "Allow switching algorithms from the UI"** - this required
  closing a real gap: the Milestone 2 grid had never actually been
  connected to the backend Warehouse API. Added the minimum honest amount
  of plumbing to make the switch mean something - a **Sync Layout to
  Server** button (create-or-update, one record per session) in Simulation
  Controls, and once synced, an **Assignment Strategy** dropdown with all
  5 strategies that `PUT`s the change immediately, reverting locally if
  the server rejects it. This is deliberately *not* the full named/
  browsable saved-layouts feature - that's explicitly Milestone 13's job
  ("Save warehouse layouts"), and building it now would just mean
  redoing it there.

**Tested thoroughly**: 30 new tests (180 total). The strategies are pure
functions tested with plain data - no engine, no database - including a
round-robin fairness test that calls it across separate planning calls and
checks the cursor persisted correctly, and a least-busy tie-break test.
`orderService`'s own dispatch logic gets a deeper integration test than
before: real `RobotEngine` and `OrderCoordinator` underneath (only the
Mongoose model boundary is mocked), proving that changing
`schedulingStrategy` from `nearest_robot` to `round_robin` actually changes
which robot gets picked, through the real service - not just at the pure
strategy-function level.

**On the frontend integration test surfacing a real (expected) sandbox
constraint**: driving the Sync button through Playwright showed it
correctly enter a disabled "Syncing…" state - and stay there far longer
than expected. Root cause: this sandbox has no live MongoDB, so the write
hangs on Mongoose's connection buffering rather than failing fast the way
a validation error does. After waiting out the ~10s buffering timeout, the
button surfaced a clear error and re-enabled itself for retry rather than
staying stuck - confirming the error handling works correctly, even though
a full "sync succeeds, dropdown appears" pass isn't observable without a
real database, the same limitation noted since Milestone 3.

## What Milestone 8 adds

Robots now share the floor safely. All of this lives in `RobotEngine`
itself (`backend/src/engine/robots/robotEngine.js`) - no new files, no new
REST routes; `POST /api/warehouses/:id/tick` exercises it automatically
since it just calls `engine.tick()`.

- **Collision detection & avoidance** - every robot tracks `currentCell`,
  the last grid cell it fully entered (kept reserved for it until it fully
  arrives at the *next* one, even mid-transit). Before advancing toward a
  waypoint, a robot checks whether any other robot currently occupies it;
  if so, it holds position instead of entering. A stationary idle robot
  blocks the aisle just like a wall would.
- **Waiting logic** - a blocked robot stays in `status: 'moving'` (it still
  has somewhere to go) but now also reports `isWaiting: true`, with a
  `waitingTicks` counter tracking how long it's been stuck.
- **Dynamic rerouting** - after `DEADLOCK_REROUTE_THRESHOLD` (3) consecutive
  blocked ticks, a robot tries routing around the congestion: the same A*
  engine from Milestone 4, called against the warehouse grid with every
  *other* robot's current cell temporarily added as a blocked cell.
- **Deadlock prevention** - two robots facing off in a single-width
  corridor is exactly what the reroute above is for: whichever one hits
  the threshold first finds a bypass (if one exists) and goes around. If
  no bypass exists (a true dead end), both keep waiting rather than the
  engine looping forever trying to force a move - `tick()` always returns
  promptly regardless.
- **Robot communication** - there's no message-passing layer, and there
  doesn't need to be: every robot lives in the same engine's `this.robots`
  map, so full visibility into everyone else's position *is* the
  communication channel here. That's a deliberate architectural choice
  for a single-process simulation, not an oversight - documented directly
  in the class's doc comment.
- **Fairness**: each tick processes robots in longest-waiting-first order
  (not fixed Map order), so contested cells go to whoever's been stuck
  longest rather than the same robot always winning a standoff.

**Tested thoroughly**: 9 new tests (189 total), including a genuine
head-on-collision test that asserts the two robots never end up having
swapped cells (which would mean they passed through each other), a
reroute test that proves the detour happened via battery drain exceeding
what the direct blocked path would have cost (not just eyeballing
position), and a true-deadlock test (solid walls, no bypass possible) that
runs 20 ticks and confirms the engine never lets them collide and never
hangs.

**Bugs my own tests caught while writing this milestone, not just the
production code**: two of my new tests initially failed from my own
mistakes, not engine bugs - I had `makeGrid(rows, cols)`'s arguments
backwards in two tests (putting a robot at x=5 on a grid only 3 columns
wide), and a "priority" test accidentally spawned one robot directly in
another's path, creating an unintended second collision that had nothing
to do with what the test meant to check. Both are fixed; a third test
initially failed for a more interesting reason - a robot moving at speed
1000 completes an entire reroute (out of its lane and back) within a
single tick, so checking its position *between* ticks never caught it
mid-detour. Fixed by asserting battery drain instead (a detour costs
strictly more than the direct path, so excess drain proves it happened,
regardless of how fast the robot completes it).

## What Milestone 9 adds

Human workers, temporary obstacles, and construction zones can now appear
and disappear mid-simulation, and robots react to them immediately - no
new files needed beyond the obstacle manager itself; everything else is
`RobotEngine` gaining awareness of a new hazard layer.

- **`engine/obstacles/dynamicObstacles.js`** (pure, no mocks needed) -
  tracks runtime-only blocked cells by type (`human_worker`,
  `temporary_obstacle`, `broken_robot`, `construction_zone`), each covering
  one or more cells (a construction zone can span an area), with an
  optional duration after which it auto-expires. `RobotEngine` owns one
  instance internally and layers it on top of the static warehouse grid
  everywhere blocking matters: spawn/destination validation, initial path
  planning, and rerouting.
- **Immediate rerouting, not the gentler wait-then-reroute from Milestone
  8** - a dynamic obstacle (or a broken-down robot) doesn't clear itself
  the way a robot that's simply in the way for a moment might, so the
  moment one appears anywhere on a robot's *remaining* path, it reroutes
  right away rather than waiting out the 3-tick threshold used for
  ordinary robot-vs-robot congestion.
- **"Broken robots" reuses the existing `error` state** rather than
  building a parallel system - `markBroken(id, reason)` puts a robot into
  `error` explicitly (same state a depleted battery or an unreachable
  destination already produces), so it blocks its own cell via the same
  collision logic every other robot already respects. The only new
  behavior is that *other* robots treat an errored robot as urgently as a
  human worker - immediate reroute, not a grace period - on the assumption
  a breakdown won't resolve itself soon.
- **REST**: `GET/POST /api/warehouses/:id/obstacles`,
  `DELETE /api/warehouses/:id/obstacles/:obstacleId`, and
  `POST /api/robots/:id/break`. Obstacles are runtime-only, same treatment
  as the task queue - not persisted to MongoDB, since they're simulation
  state rather than warehouse layout.

**Tested thoroughly**: 24 new tests (221 total) - 14 pure tests for the
obstacle manager itself (types, expiry timing, multi-cell zones), 8 for
its integration into `RobotEngine` (avoiding obstacles when planning,
rerouting immediately when one appears mid-path, an expired obstacle
correctly reopening a route), 3 for `markBroken`, plus REST-layer tests
for every new endpoint. A live demo confirms the behavior end to end: a
robot cruising down a corridor detours around a human worker who steps
into its path *one tick after* the worker appears - not three.

## What Milestone 10 adds

The dashboard is live now, not just a grid editor: robots render on the
canvas, the sidebar shows the real fleet, and three new panels turn the
backend's simulation state into something you can actually watch.

- **Robots on the canvas** - each robot is a filled circle colored by
  status (idle/moving/charging/error), with a heading tick showing which
  way it's facing and a thin arc around it showing battery level
  (green/amber/red by threshold) - both readable directly off the floor
  plan, not just from a list.
- **Fleet Roster** (Sidebar) - the Milestone 1 placeholder is now a real,
  live list: name, status, a battery bar, and position for every spawned
  robot.
- **Active Orders panel** - pending/assigned/picked-up orders with
  priority badges, newest first.
- **Fleet Activity chart** - active-robot-count and delivered-order-count
  over time, via `recharts`, accumulated client-side from polled data.
- **Traffic heatmap** - a togglable overlay on the canvas shading cells by
  how often a robot has actually been there, accumulated from real
  observed positions (not synthetic data).
- **Warehouse utilization** - percentage of the fleet currently
  moving-or-charging vs. idle, alongside average battery, in the
  Statistics panel.
- **The minimum controls needed to make any of this show real data**:
  "Spawn Robot" (places one on a random free walkable cell),
  "Generate Orders", "Dispatch Now" (manual, same endpoint Milestone 6
  built), and "Start/Stop Simulation" (a client-side interval that calls
  the existing `tick` endpoint every 500ms while running).

**An honest architectural note on "live"**: this dashboard is
poll-driven (`useLiveSimulation.js` fetches robots/orders once a second,
and the tick loop is a plain `setInterval` calling the REST API) rather
than push-driven. That's deliberate, not a shortcut - Socket.IO
integration is explicitly Milestone 11's job, and building real-time push
here would mean redoing this exact data flow there. The hook's output
shape (robots, orders, counts, history) is already what a socket
subscription would feed into; Milestone 11 should be able to swap the
transport underneath these same components with minimal rework.

**On testing, and what this sandbox still can't verify**: same
limitation as Milestones 7 and 9 - no live MongoDB means I can't observe
a robot actually spawning and moving through the real UI here. What I did
verify: the full build succeeds, a Playwright pass confirms every new
component renders without error in the default (unsynced) empty state -
including the chart and heatmap toggle handling zero data gracefully -
and the underlying REST endpoints this hook calls are already covered by
221 backend tests. The gap is real and worth naming rather than glossing
over: the polling/tick-loop logic itself has not been exercised against a
live backend in this environment.

## What Milestone 11 adds

The dashboard is push-driven now, not polled: robot movement, order status,
obstacle changes, and notifications all arrive over Socket.IO as they
happen, instead of `useLiveSimulation.js` fetching on a timer.

- **A server-owned tick loop, per warehouse.** Milestone 10's client-side
  `setInterval` calling the REST `tick` endpoint is gone. `Start
  Simulation` now emits `simulation:start`, and one interval on the
  server (`sockets/tickLoopManager.js`) advances that warehouse for
  *every* connected client watching it - so the simulation keeps running
  for other viewers even if whoever clicked Start closes their tab, and it
  stops itself automatically once nobody is left watching rather than
  ticking forever in the background.
- **One tick implementation, two callers.** The tick logic that used to
  live directly in `warehouse.controller.js` is now `tickRunner.runTick()`,
  shared by both the manual REST endpoint (still there, useful for
  scripting a single step) and the automatic server loop - so there's a
  single source of truth for what "advance the simulation" does.
- **A decoupling event bus.** `src/events/simulationEvents.js` is a plain
  `EventEmitter` that `tickRunner`, `orderService`, and the
  warehouse/robot controllers emit into; `sockets/index.js` is the only
  thing that listens, translating each event into a broadcast to the
  right warehouse's Socket.IO room (`warehouse:<id>`). This is what let
  all 221 pre-existing tests keep passing untouched - they mock the
  services directly and never load the sockets module, so emitting into
  an unlistened bus is just a no-op.
- **What's synced in real time**: robot movement and state changes
  (`robots:changed`/`robots:removed`), order lifecycle events
  (`orders:changed` - treated by the frontend as an invalidation signal
  that triggers one targeted re-fetch, since order documents carry more
  fields than a tick event does), the full obstacle list whenever it
  actually changes (`obstacles:changed`), and a small live notification
  feed for robot errors and deliveries (`notification`).
- **Obstacles are now visible on the canvas** - a diagonally-hatched
  overlay tinted by type (human worker, temporary obstacle, broken robot,
  construction zone), sitting below robots so the fleet stays the clearest
  thing on screen. This was tracked server-side since Milestone 9 but
  never rendered; real-time sync made it worth actually showing.
- **Reconnect handling** - a dropped connection loses Socket.IO room
  membership server-side, so on reconnect the frontend rejoins the
  warehouse room and re-fetches a full snapshot rather than trusting
  whatever state accumulated before the drop.

**A pre-existing gap, surfaced but not fixed here**: `POST /api/robots`
creates the robot in MongoDB but doesn't add it to an already-cached live
engine (`simulationManager.getEngine` only seeds from Mongo on a cache
miss). A robot spawned after the engine was first loaded will show up in
every connected client's roster immediately (the `robots:changed` event
still fires) but won't actually move until the engine cache is next
rebuilt. This predates Milestone 11 and is a real-time-sync
implementation, not a simulation-correctness one, so it's called out
rather than fixed in scope here.

**On testing, and what this sandbox still can't verify**: this milestone
got a real integration test that Milestones 7, 9, and 10 couldn't - a
genuine HTTP server with Socket.IO attached, exercised by an actual
`socket.io-client`, covering room isolation, event forwarding for every
event type, and the full start/stop/auto-stop tick-loop lifecycle (18 new
tests: 12 for `tickLoopManager`, 6 end-to-end socket tests), on top of the
existing 221 (239 total, all passing). The frontend build still succeeds.
What's still unverified in this environment: an actual live MongoDB
behind a running server, so I can't watch a real browser tab receive a
real `robots:changed` event from a real tick against real data - the gap
is the same shape as prior milestones, just one layer further along the
stack.

## What Milestone 12 adds

The A* engine already had this coming: `astarSteps` (Milestone 4) was
written as a generator yielding a snapshot after every node expansion,
with a comment saying this milestone would drive it directly. It did -
almost no new algorithm code, mostly plumbing a richer snapshot through to
an interactive panel.

- **`trace: true` is opt-in, not the default.** The Robot Engine calls
  through this same generator (via `findPath`) on every tick for live
  pathfinding and replanning - that's a hot path Milestone 14
  (Optimisation) will be tuning. So the cheap snapshot shape (current
  node, closed-set size) is unchanged and still what every existing
  caller gets. Only when `trace: true` is passed does each snapshot also
  build the *full* open set (derived from `gScore` minus the closed set,
  so it reflects best-known cost, not stale duplicate queue entries) and
  attach h/f/parent to every node - the extra detail this panel needs, at
  the extra cost only this panel pays.
- **`findPathWithTrace`** runs the same search as `findPath` while
  collecting that per-step recording, capped at `maxTraceSteps` (400 by
  default) so a pathological search on an 80x80 grid can't build an
  unbounded response - the search still always runs to completion for the
  real result (`found`/`path`/`cost`/`nodesExplored`/`executionTimeMs`);
  the cap only limits how many intermediate frames get kept for scrubbing,
  flagged via `stepsTruncated: true` when it's hit.
- **`POST /api/warehouses/:id/path`** (Milestone 4's existing route)
  gained an optional `trace` body flag rather than a new endpoint - it was
  already "a way to inspect/test the A* engine against real saved
  layouts", this is the same thing with more detail attached.
- **The AI Visualisation Panel** (`usePathVisualization.js` +
  `AIVisualizationPanel.jsx`): pick a start and a goal cell directly on
  the canvas (a self-contained pick mode, not a new grid-editing tool - it
  records a coordinate, it never paints), choose a heuristic and whether
  diagonal movement is allowed, then run the search and scrub through it
  with step forward/back, play/pause, and a speed slider. Stats shown:
  execution time, nodes explored, path cost, and (per current step) the
  open/closed set sizes and the current node's g/h/f.
- **On the canvas**: the open set (translucent cyan), closed set
  (translucent grey), thin parent-pointer lines showing the search tree
  so far, the current node as a bold ring, start/goal markers, and - once
  found - the final path as a connected line. Drawn under the live robot
  fleet, so if both happen to be visible at once the fleet still reads as
  the primary thing on screen.

**On testing**: 7 new backend tests for `findPathWithTrace` itself
(matching `findPath` on the real result, the open set's best-known-cost
invariant, the truncation cap firing exactly at the configured limit and
recovering the identical final result whether capped or not) plus 4 more
on the `POST /path` endpoint's `trace` flag - 249 backend tests total, all
passing. The frontend build is clean. Same caveat as every milestone
before this one: no live MongoDB or browser in this sandbox, so the
interactive scrubbing itself is unverified beyond the build succeeding and
the data it consumes being correct at the source.

## What Milestone 13 adds

Seven sub-features were listed for this milestone. Two turned out to
already exist: import/export JSON shipped back in an earlier milestone,
and the Log REST API (list/get/create/delete) has existed since
Milestone 3 - it just had nothing writing to it from the UI. The rest:

- **Battery charging / charging stations, made autonomous.** Charging
  itself already worked (Milestone 5) but only manually - a robot had to
  be sent to a charging cell and told to start. Now `RobotEngine.tick()`
  checks every idle robot each tick: at or below a 20% battery threshold
  with nothing else queued, it autonomously routes to the nearest
  *reachable* charging station (skipping over ones that are walled off or
  temporarily cut off by a dynamic obstacle, trying the next-closest
  instead) and starts charging on arrival - or immediately, if it's
  already standing on one. It never preempts an explicitly assigned
  destination. A failed search (no reachable station right now) sets a
  cooldown rather than re-running pathfinding against every station on
  every single tick; the cooldown is retried, not permanent, so a
  temporarily blocked path is revisited once the obstacle clears.
- **Saved warehouse layouts.** The backend needed nothing new here - list,
  get, and delete warehouse endpoints already existed from Milestone 3.
  The gap was entirely in the editor, which only ever created-or-updated
  one record per session and could never load a different one back in.
  `useSimulationGrid.js` gained a `layoutName` field, `saveLayoutAs`
  (always creates a new record rather than updating the current one), and
  `loadLayout`/`refreshSavedLayouts`/`deleteLayout`, surfaced through the
  new **Saved Layouts** panel: name a layout, save it as new, browse
  everything saved so far (name, dimensions, last updated), load one back
  into the editor, or delete one.
- **Warehouse generator.** A new pure function,
  `engine/grid/warehouseGenerator.js`, procedurally lays out repeating
  shelf blocks separated by walkway aisles, a few charging stations along
  the bottom edge, and dock cells along the top - wired to a density
  selector (sparse/balanced/dense) and a "Generate Layout" button in the
  Simulation Controls panel, so demoing a fleet doesn't require
  hand-painting a grid from scratch every time.
- **Logging, surfaced.** The backend has been writing `Log` entries since
  Milestone 3 (robot errors, order deliveries, unreachable destinations),
  but nothing ever read them back. The new **Logs** panel lists them,
  filterable by level, scoped to the currently synced warehouse when
  there is one.
- **Notifications, now with real persistence.** Milestone 11's live
  NotificationsFeed was explicitly flagged as a first pass - it's
  accumulated Socket.IO events sitting in memory, gone on refresh. Rather
  than build a second, parallel notification-persistence system, the Logs
  panel above *is* that persistence: every notification-worthy event was
  already being written to the same `Log` collection, so reading it back
  is what makes those events survive a reload.
- **Keyboard shortcuts.** A new `useKeyboardShortcuts` hook wired at the
  app level: `1`-`6` switch tools, `Delete`/`Backspace` erases the
  selected cell, `Space` starts/stops the live simulation, `Escape`
  cancels the AI Visualisation Panel's pick mode (or deselects the
  cell), and `?` opens a shortcuts reference overlay. Every shortcut is
  ignored while focus is on a text input, so typing a layout name or a
  resize value can't accidentally trigger one.

**On testing**: the auto-charging behavior is the one piece of this
milestone that lives in the engine, and it's the one piece that got real
test coverage - 8 new backend tests (above threshold does nothing,
routes to the nearest *reachable* station and skips an unreachable closer
one, doesn't preempt an explicit destination, can't move at exactly 0%
battery, does nothing with no charging cells in the warehouse, and the
cooldown-then-retry behavior once a blocking obstacle clears) - 257
backend tests total, all passing, confirmed with two full runs to rule
out timing flakiness in the unrelated Socket.IO integration suite. The
rest of this milestone is frontend UI and state wiring with no backend
counterpart to unit test against, verified only by a clean production
build - the deepest an unverified claim goes in this milestone is that
wiring, not any new algorithm or data-correctness question.

## What Milestone 14 adds

This milestone was about measuring before changing anything, and being
honest about the two areas that turned out already fine rather than
inventing busywork to look productive in every category listed.

- **A\* efficiency - the real find.** `astarSteps` (Milestone 4) has always
  built a snapshot after every node it expands, for the AI Visualisation
  Panel's benefit. But it did that *unconditionally* - even for `findPath`,
  called by the Robot Engine on every tick for every robot that's moving or
  being replanned, which never even looks at the intermediate values, only
  the generator's final return. The cheap (non-trace) snapshot still copied
  the entire closed set into a fresh array every single iteration, so
  `findPath` was paying O(n²) in nodes explored for bookkeeping nobody
  read. `astarSteps` now takes an `emitSteps` option (default `true`,
  unchanged for every existing caller); `findPath` passes `emitSteps:
  false`, so the whole search now runs inside a single generator
  `.next()` call with no snapshot built at all. Measured on a 60x60 "comb
  maze" grid (a layout designed to force a long serpentine path rather
  than a short direct one) exploring 1,830 nodes: **712ms → 13ms, a 54.8x
  speedup** - same path, same cost, same node count, just without the
  per-iteration copying. `astarSteps`, `findPathWithTrace`, and the AI
  Visualisation Panel are completely unaffected (they still default to
  `emitSteps: true`).
- **Database queries.** Robot position/status updates after a tick went
  from one `Robot.findByIdAndUpdate` call per changed robot to a single
  `Robot.bulkWrite` covering all of them (`simulationManager.persistRobots`,
  new). At the milestone's target of 50 simultaneous robots with most of
  them moving most ticks, that's up to 50 separate round trips collapsed
  into one, every 500ms, indefinitely. The same pattern was applied to
  order-assignment writes in `dispatchPendingOrders` and status-transition
  writes in `processTickEvents` (the latter keeps `ordered: true` as cheap
  defensive insurance against a same-order double-update within one
  bulk call - confirmed that can't happen today given how
  `OrderCoordinator.processTick` works, but it costs almost nothing to
  guard against that invariant ever loosening). Separately, Milestone 13's
  Logs panel filters by `warehouseId` and sorts by recency, and no
  existing index covered that combination - `Log` gained
  `{ warehouseId: 1, createdAt: -1 }`. The single-robot persistence path
  (`persistRobot`, used by the four robot-action endpoints that only ever
  change one robot at a time) is untouched - bulking a single write has
  no benefit.
- **Memory usage.** Found and fixed one real, unbounded-over-time leak:
  `tickRunner`'s per-warehouse "last broadcast obstacle list" cache never
  released an entry when that warehouse was later deleted or its engine
  cache invalidated. Now cleaned up (`tickRunner.forgetWarehouse`)
  alongside the existing `simulationManager.invalidate()` calls in
  `warehouse.controller.js`. Everything else reviewed for this
  (`useLiveSimulation.js`'s heatmap, history, and notifications state on
  the frontend) was already correctly bounded from the milestones that
  introduced them - capped arrays or capped-by-grid-size maps, not
  genuine leaks, so left alone.
- **Robot scheduling and rendering speed - reviewed, found already
  sound, left alone.** The scheduling strategies (Milestone 7) rank
  candidates by geometric distance, not real pathfinding, so dispatch was
  never paying A\* costs per candidate in the first place - there was
  nothing to fix. The canvas (Milestone 2/10) already clips every render
  to the visible viewport rather than redrawing off-screen cells, and
  already batches draw calls through `requestAnimationFrame` with a
  scheduled-flag guard rather than drawing synchronously on every state
  change. Changing either without evidence they were actually slow would
  have been optimization theater, not optimization.
- **A bug this review caught, unrelated to performance but worth fixing
  while looking closely at the same files.** Milestone 13's keyboard
  shortcuts bound start/stop to Space - which turned out to collide with
  GridCanvas's existing hold-Space-to-pan behavior from Milestone 2/10.
  Holding Space to pan around the grid would also re-fire the shortcut
  handler on every OS key-repeat event, toggling the simulation on and
  off while someone was just trying to look around. Rebound to `P`, and
  every shortcut now ignores key-repeat events on principle (holding "1"
  down, for instance, never had a reason to call `onSetTool` repeatedly
  either).
- **A reusable fleet-scale benchmark.** `backend/scripts/benchmark.js`
  (`npm run benchmark`, or `node scripts/benchmark.js <robots> <ticks>`)
  drives the real `RobotEngine`/`OrderCoordinator`/scheduling directly, no
  MongoDB required, and reports tick-time percentiles against the
  milestone's explicit targets. At 50 robots on a 60x60 layout: p50 tick
  time 1.5ms, p95 8.2ms, max 21.7ms - p95 uses about 1.6% of the 500ms
  production tick budget. Pushed to 100 robots (double the target): p95
  13.3ms, still under 3% of budget. This measures the engine's CPU cost
  only, not the database write or Socket.IO broadcast tickRunner.js also
  does each tick - the script's own header comment says so plainly rather
  than implying it's a full end-to-end number.

**On testing**: 8 new/changed backend tests directly exercise this
milestone's changes - 2 for the A\* `emitSteps` behavior (including the
54.8x comparison above, with a generous 2x margin so it can't flake on a
noisy runner), 5 for `persistRobots`'s bulk-write shape (new dedicated
`tests/services/simulationManager.test.js`), plus updated assertions in
`tests/simulation.test.js` and `tests/orders/orderService.test.js` for the
new bulk-write call patterns. 265 backend tests total, all passing,
confirmed with three full runs (the same Socket.IO integration suite
flakiness noted in Milestone 13 showed up once again on one run out of
three here too - a real-timer sensitivity in that specific suite, not a
regression from anything touched this milestone, since nothing here
touched sockets code). The frontend's only change this milestone was the
Space/P shortcut fix above - confirmed with a clean rebuild rather than
any deeper testing, the same limitation every prior milestone's frontend
work has had (no frontend test runner in this project, see Milestone 10's
README note).

## Milestone roadmap

1. **Project Setup** ✅
2. **Warehouse Grid Engine** ✅
3. **Database Models & REST APIs** ✅
4. **A\* Pathfinding Engine** ✅
5. **Robot Engine** ✅
6. **Order Management** ✅
7. **Robot Scheduling** ✅
8. **Multi-Robot Coordination** ✅
9. **Dynamic Obstacles** ✅
10. **Live Simulation Dashboard** ✅
11. **Socket.IO Integration** ✅
12. **AI Visualisation Panel** ✅
13. **Advanced Features** ✅
14. **Optimisation** ✅
15. **Testing & Deployment** ✅ - see [`README.md`](../README.md) and [`docs/`](.)

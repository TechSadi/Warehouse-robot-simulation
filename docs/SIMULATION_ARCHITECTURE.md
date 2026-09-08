# Simulation architecture

How the live simulation actually works: who owns which piece of state, what
advances time, what stops two things happening at once, and what happens
when any of that is interrupted.

[`ARCHITECTURE.md`](./ARCHITECTURE.md) covers the system as a whole - this
document is only about the simulation core, and it is the reference for the
rules the rest of the code is written against.

---

## 1. Authoritative state

Everything in this application is either **persistent** (MongoDB knows it,
and it survives a restart) or **runtime** (the process knows it, and it does
not). Almost every bug this design exists to prevent came from a piece of
state that quietly belonged to both.

| State | Owner | Persisted? | Notes |
|---|---|---|---|
| Which warehouses/robots/orders exist | MongoDB | Yes | Identity and ownership. The engine is seeded from this; it never invents a robot. |
| Warehouse layout (`rows`, `cols`, `cells`) | MongoDB | Yes | Read once when an engine is built. Changing it rebuilds the engine. |
| `schedulingStrategy` | MongoDB | Yes | Re-read on every dispatch, so a change takes effect without a reload. |
| Robot identity (`name`, `speed`) | MongoDB | Yes | Client-editable through `PUT /api/robots/:id`. |
| **Robot position, rotation, battery, status** | **RobotEngine** | Written back each tick | Simulation-owned. The REST DTO refuses to write these at all. |
| **Robot task queue and current path** | **RobotEngine** | No | Plain `{x, y}` destinations, in memory only. |
| **Dynamic obstacles** | **DynamicObstacleManager** | No | Runtime hazards layered over the static grid, not part of the saved layout. |
| **Order ↔ robot assignment (which leg a robot is on)** | **OrderCoordinator** | No | This is the map that turns "a robot arrived" into "an order advanced". |
| Order lifecycle status | MongoDB | Yes | Written by the engine's tick path *and* the REST API, both through the same state machine. |
| Whether a simulation is running | TickLoopManager | No | One interval per warehouse, per process. |
| Logs and statistics snapshots | MongoDB | Yes | Append-only history. |

The flow is one-directional while a warehouse is loaded:

```mermaid
flowchart LR
    Engine["RobotEngine<br/>(authoritative: physical state)"]
    Mongo[("MongoDB<br/>(authoritative: identity,<br/>layout, order status)")]
    Client["Connected clients"]

    Engine -- "persistRobots() after every tick" --> Mongo
    Mongo -- "seeds a new engine (once, at construction)" --> Engine
    Engine -- "simulationEvents -> Socket.IO" --> Client
    Mongo -- "REST reads" --> Client
```

MongoDB therefore lags the engine by at most one tick, and is written *from*
it - never the other way round while an engine is loaded. The single moment
the arrow reverses is engine construction, and that is also the single
moment the two can disagree, which is what §6 is about.

Two consequences worth stating plainly, because they are choices and not
accidents:

- **Runtime-only state is genuinely lost when an engine is dropped.** A
  robot's path, its queued destinations, the active obstacles, and the
  coordinator's assignments do not survive a restart or a layout change.
  Everything downstream of that is designed around it rather than pretending
  otherwise.
- **There is no optimistic-concurrency guard on the robot writes.** There
  does not need to be: while an engine is loaded it is the sole writer of
  physical state, and every write to it is serialized (§3). The REST API
  cannot write those fields at all.

---

## 2. The tick: one mechanism

`tickRunner.runTick(warehouseId, deltaSeconds)` is the only thing that
advances simulation time. One tick means, in order:

1. Expire any timed dynamic obstacles, then move every robot by
   `speed * deltaSeconds` (`engine.tick`).
2. Persist every changed robot in one `bulkWrite`, and broadcast them.
3. Turn arrivals into order events (`coordinator.processTick`) and persist
   those, each guarded by the order state machine.
4. Log and notify for any robot that entered the `error` state.
5. Dispatch pending orders onto newly-idle robots.
6. Broadcast the obstacle list, but only if it changed.

| Question | Answer |
|---|---|
| Who can trigger a tick? | `POST /api/warehouses/:id/tick` (one manual step, rate-limited, owner-only) and the server-owned interval loop started by `simulation:start`. Nothing else. |
| What happens when two ticks arrive together? | They are serialized by the warehouse lock (§3) and applied one after the other. Two ticks never interleave, and neither is lost. |
| What happens when an *automatic* tick arrives while one is running? | It is **dropped**, not queued (`runAutoTick`). Queueing would let a slow tick build a backlog that then replays as a burst of catch-up ticks, fast-forwarding the simulation. A dropped interval means that interval produced no motion, which is the honest outcome. |
| What happens when a tick fails? | The error propagates to the caller (a 500 for the REST endpoint), the lock is released, and the loop counts the failure and tries again next interval. A failed tick never wedges the warehouse. |
| What happens if a simulation is started twice? | The second start changes nothing - one interval per warehouse, never one per client - but it is acknowledged: the requester gets a `simulation:status` with `changed: false`. A client that hears nothing back cannot tell "already running" from "my request was dropped". The first start's cadence stays in effect. |
| What happens if it is stopped twice? | The same, in reverse: a reported no-op. "Stopped" is the state the caller asked for and the state they get. |
| How do automatic and manual ticking interact? | They share the lock, so a manual tick during automatic ticking is applied strictly *between* two automatic ticks. It is an extra step, never a step on top of a step. |

---

## 3. Concurrency model

**One FIFO queue per warehouse.** `services/warehouseLock.js`.

Node is single-threaded, but every simulation operation is `async` with at
least one `await` between reading state and writing it back - and an `await`
is a yield point. Before the lock, a REST tick landing while the interval
loop was mid-tick, a dispatch racing the tick that triggered it, or an
obstacle added while a robot was being replanned around the *old* obstacle
set all interleaved freely, each assuming it was the only writer.

Warehouses are fully independent - nothing in this simulation spans two of
them - so serializing per warehouse costs nothing in throughput while making
every operation on a single warehouse atomic with respect to every other.

```mermaid
flowchart TB
    subgraph A["Warehouse A - serialized"]
        direction LR
        A1["tick"] --> A2["dispatch"] --> A3["obstacle change"] --> A4["robot create/delete"] --> A5["start/stop"]
    end
    subgraph B["Warehouse B - serialized, independently"]
        direction LR
        B1["tick"] --> B2["dispatch"]
    end
    A -.->|"no interaction"| B
```

Everything that mutates one warehouse's simulation goes through it:

| Operation | Entry point |
|---|---|
| Tick (manual and automatic) | `tickRunner.runTick` / `runAutoTick` |
| Dispatch | `orderService.dispatchPendingOrders` |
| Robot create / delete | `POST /api/robots`, `DELETE /api/robots/:id` |
| Robot task / charge / clear-error / break | `POST /api/robots/:id/{tasks,charge,clear-error,break}` |
| Obstacle add / remove | `POST`/`DELETE /api/warehouses/:id/obstacles` |
| Layout change and warehouse delete | `PUT`/`DELETE /api/warehouses/:id` |

Three details that matter:

- **Re-entrancy is avoided by construction, not detected.** `runTick`
  already holds the lock when it dispatches, so it calls
  `dispatchPendingOrdersLocked` - the same work without the lock. Calling
  the public `dispatchPendingOrders` there would deadlock, and the two names
  are the reason nobody does it by accident.
- **The queue is bounded** at 32 waiting operations. Past that, callers get
  a `503` instead of being queued. A backlog that deep means work is
  arriving faster than the simulation can absorb it, and queueing it anyway
  converts a burst of requests into unbounded memory growth and
  ever-staler responses.
- **A rejection releases the lock.** The chain continues past a failed
  operation, so one bad tick cannot wedge a warehouse for the life of the
  process.

This is deliberately a single-process, in-memory lock. It is correct for the
deployment this application has - one Node process owning every live engine,
exactly like the engine cache itself. A distributed lock would only mean
something if the engine state were shared too, and it is not. See
[Known limitations](#10-known-limitations).

### One engine per warehouse

`simulationManager` caches the **promise** of an engine, not the resolved
instance. With a plain instance cache, `getEngine` had an `await` between
"is it cached?" and "cache it", so two callers arriving together both missed,
both built a `RobotEngine`, and both wrote it to the map. The loser's engine
went on existing as a detached second simulation of the same warehouse, with
robots that nothing would ever tick again. Caching the in-flight promise
makes the first caller the only builder and every concurrent caller a
subscriber to it. The `OrderCoordinator` is validated against the engine it
was built for, so it can never end up driving a previous generation's fleet.

---

## 4. Robot state machine

Declared once in `domain/robotLifecycle.js`, and now enforced on both sides:
the REST layer checks it, and `RobotEngine._setStatus` asserts it on every
internal transition. Before that, the engine assigned `robot.status`
directly in eight places, so the table described the side door and not the
front one.

```mermaid
stateDiagram-v2
    [*] --> idle: spawn
    idle --> moving: a task is assigned and a path exists
    moving --> idle: path complete, queue empty
    idle --> charging: on a charging cell (manual, or auto below 20%)
    charging --> idle: battery full
    idle --> error: no path to the destination
    moving --> error: battery depleted / marked broken
    charging --> error: marked broken
    error --> idle: clearError
```

| Situation | Behaviour |
|---|---|
| Movement | Distance budget of `speed * deltaSeconds` is spent across the path, across as many waypoints and queued tasks as it covers, with interpolated positions in between. |
| Blocked by another robot | Holds position (`isWaiting`). After 3 consecutive blocked ticks it replans around the congestion, which is what breaks a head-on standoff. |
| Dynamic obstacle or a broken robot on the path | Replans immediately - neither is expected to clear on its own. |
| Battery depletion | Stops in `error`, **parked on the whole cell it last fully entered**, with the interrupted destination pushed back to the front of the queue. |
| Low battery | An idle robot at or below 20% routes itself to the nearest *reachable* charging station. Never preempts an explicitly queued destination. |
| Unreachable destination | `error`, with the destination kept queued so it is retried after `clearError` rather than silently dropped. |
| Task completion | Falls through to the next queued destination in the same tick if budget remains. |
| Task failure | See the order machine below - a failed robot releases its order. |
| Collisions | Impossible by construction: a robot only ever advances into a cell no other robot currently occupies, checked at every waypoint boundary rather than once per tick. |

Two rules exist because breaking them produced real bugs:

- **A robot at rest is always on a whole cell.** Positions are fractional
  only *while* moving. `_drainBattery` and `markBroken` snap to
  `currentCell`, and planning starts from `currentCell`, never `position`.
  A* is a grid search, so a fractional start names a node it can never
  reach: it explored an entire lattice offset from the real grid and then
  reported "no path" for a plainly reachable destination. This was
  reachable in production via `clearError` on a robot whose battery ran out
  mid-step.
- **The task queue is capped** at 64 destinations. `POST /api/robots/:id/tasks`
  is a client-driven path into it, and every entry is re-planned as the
  robot works through it.

---

## 5. Order state machine

Declared once in `domain/orderLifecycle.js`. The REST API validates against
it directly; the simulation's tick path expresses the same rule as a query
filter (`status: { $in: predecessorsOf(next) }`), so an illegal move matches
no document rather than being applied and then noticed. That is what lets a
tick already in flight fail safely against an order the user just cancelled.

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> assigned
    assigned --> picking_up
    assigned --> picked_up: engine express edge
    picking_up --> picked_up
    picked_up --> delivering
    picked_up --> delivered: engine express edge
    delivering --> delivered
    assigned --> pending: released
    picking_up --> pending: released
    picked_up --> pending: released
    delivering --> pending: released
    pending --> cancelled
    assigned --> cancelled
    picking_up --> cancelled
    picked_up --> cancelled
    delivering --> cancelled
    delivered --> [*]
    cancelled --> [*]
```

The engine observes a robot only at the moment it *arrives* somewhere, so it
advances an order a full leg at a time - hence the two "express" edges.
`picking_up` and `delivering` remain available to API clients driving an
order by hand.

**The release edges** (`* -> pending`) were added in this phase, and are the
important part. Every one of them clears `assignedRobot`, `assignedAt` and
`pickedUpAt`; none of them can reach `delivered`, which stays terminal and
only ever reachable from an actual delivery. They exist because an order
could previously become permanently stranded - not terminal, so it stayed
`picked_up` forever, pointing at a robot that was no longer carrying it,
while the dispatcher only ever looks at `pending`. Four things now release
an order instead of stranding it:

| Trigger | Path |
|---|---|
| The robot carrying it failed (flat battery, marked broken, route cut off) | `order_failed` event → back to `pending` |
| The delivery point became unreachable after pickup | `delivery_unreachable` event → back to `pending` |
| The robot was deleted | `orderService.releaseOrdersForRobot` |
| The engine was rebuilt (restart, layout change) | `simulationManager.reconcileWarehouse` |

Cancelling or un-assigning an order through the REST API also reaches the
simulation: the coordinator's assignment is dropped *and* the robot's queued
destinations are cleared, so it stops driving toward a delivery nobody is
waiting on.

**Robots cannot be assigned impossible tasks.** The scheduler only considers
idle, unassigned robots above the low-battery threshold; `assignOrder`
re-checks that independently and refuses a robot that is already on an order
or not idle; and an order whose pickup point is unreachable is left
`pending` rather than marked `assigned`.

---

## 6. Recovery model

**Reconstruct from persistence, then reconcile.** No snapshot file, no
event log, no replay.

Every engine is built by `simulationManager._loadEngine`, which is also the
only place the two halves of the system can disagree - so that is where the
disagreement is resolved. It runs on a genuine process restart and on any
cache invalidation (a layout change), because both lose exactly the same
runtime state and both need exactly the same fix.

| Persisted state | What happens on load |
|---|---|
| Robot `idle` | Loaded as-is. |
| Robot `moving` | Loaded **idle** at its last cell. Its path lived only in memory and the world may have changed under it; it is re-dispatched normally. Mongo is corrected. |
| Robot persisted mid-cell (fractional position) | Snapped to the nearest whole cell, and Mongo corrected. Without this the spawn was rejected and a restart mid-move silently dropped the robot from the fleet. |
| Robot `charging`, still on a charging cell | Resumes charging. |
| Robot `charging`, no longer on a charger | Loaded idle. |
| Robot `error` | Stays broken. A restart is not a repair. |
| Robot on a cell that is no longer walkable, or contended by another robot | Left out of the engine, and marked `error` in Mongo with the reason. Previously it was dropped silently - absent from the simulation, but still listed through the API as a healthy idle robot. |
| Order in any in-flight state | Released to `pending` with its assignment cleared. |

Loads are **deterministic**: robots are seeded in id order, so two loads of
the same data resolve contention (two robots persisted on one cell) the same
way rather than however Mongo happened to order the result set.

Reconciliation failures are logged, never thrown - recovery bookkeeping must
never be the reason a warehouse cannot be simulated at all. A failed *load*
is not cached, so one bad database read does not break a warehouse for the
life of the process.

What this deliberately does **not** do: resume in-flight movement, replay
missed ticks, or restore obstacles. The goal is that MongoDB is not left in a
misleading state, not that the simulation continues as though nothing
happened.

---

## 7. Socket.IO synchronisation

A reconnecting client has **not** stayed synchronised. Socket.IO reconnects
transparently, which makes this easy to forget: room membership is dropped
server-side on disconnect, and every event broadcast during the gap is gone -
they are fire-and-forget broadcasts, not a replayable stream.

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    C->>S: warehouse:join (after connect or reconnect)
    S->>S: ownership check
    S-->>C: warehouse:joined
    S-->>C: simulation:sync (robots + obstacles + running)
    S-->>C: simulation:status
    S-->>C: orders:changed { reason: "sync" }
    C->>S: GET /api/orders?warehouseId=...
    Note over C,S: from here, incremental events
```

- **Joining always resyncs.** `simulation:sync` carries the live engine's
  robots (sub-tick-accurate, not the last persisted snapshot), the current
  obstacles, and whether the simulation is running. `simulation:sync` can
  also be requested explicitly at any time.
- **Snapshots replace, they do not merge.** The point of a resync is that
  what the client accumulated may be wrong; merging would preserve exactly
  the stale entries it is meant to discard - a robot deleted during the gap,
  say, which no future `robots:changed` would ever mention again.
- **Orders are re-fetched over REST**, not pushed. Order documents carry
  more fields than a tick event does, so `orders:changed` is an invalidation
  signal rather than a diff.
- **`simulation:status` is sent to the requester on every start/stop**, even
  when nothing changed, and to the room when it did.
- **A deleted warehouse tells its watchers.** `warehouse:deleted` stops the
  tick loop, notifies the room, and evicts everyone from it, rather than
  leaving clients watching a frozen view.
- Authorization is re-checked on **every** warehouse-scoped event, not only
  at join.

---

## 8. A* architecture

`engine/pathfinding/astar.js` is a generator: `astarSteps` yields a snapshot
per expanded node, `findPath` drains it for the final result, and
`findPathWithTrace` collects the snapshots for the AI Visualisation Panel.
One search implementation, three ways to consume it.

Three cost controls, each for a different caller:

| Control | Default | Why |
|---|---|---|
| `emitSteps: false` | set by `findPath` | The hot path (every moving robot, every tick) builds no snapshots at all. Even the cheap snapshot copies the whole closed set per iteration, which made `findPath` quadratic in nodes explored for data nobody read. |
| `maxEmitSteps` | set by `findPathWithTrace` to `maxTraceSteps` | Stops *building* traced snapshots past the cap instead of building and discarding them. Each traced snapshot is O(frontier + closed set); on a dense grid the discarded ones dominated the request. |
| `maxIterations` | `rows * cols * 8` | A hard ceiling on any single search. |

Pathological inputs are rejected before the search rather than discovered
during it:

- **Non-integer coordinates** - A* here searches integer cells keyed
  `"x:y"`, so a fractional start or goal names a node it can never reach.
  It used to explore a whole lattice offset from the real grid before
  reporting failure at the iteration cap; it now answers in constant time,
  with the same answer.
- **Non-finite, negative, and out-of-bounds coordinates** - rejected up
  front. `isWalkable` alone would accept `(NaN, 0)`: "in bounds" by
  comparison and "not blocked" by a `Set` lookup that will never contain it.
- **Malformed grid dimensions** - `rows * cols * 8` is `NaN` for those, and
  `i < NaN` happens to be false. That failed safe by accident rather than by
  decision; it is now resolved explicitly.
- **Start equals goal** - answered immediately, zero cost, zero nodes.
- **Unreachable goal** - explores the reachable region and stops.

Visualisation is unaffected: `found`, `path`, `cost`, `nodesExplored` and
`executionTimeMs` are identical whether or not a trace is recorded, and
`stepsTruncated` still says when the recording is partial.

---

## 9. Data lifecycle

Every document in this application reaches its owner through a warehouse:

```text
User
 └── Warehouse
      ├── Robots
      ├── Orders
      ├── Logs
      └── Statistics
```

Authorization is derived from that chain, which is why deleting a warehouse
without its children was not merely untidy: the children became
*unreachable*. Nothing could list, read or delete them through the API, by
anyone, ever. They only accumulated.

**Deletion is a hard cascade**, children first. The reasoning:

- A soft delete earns its complexity when something still needs to read the
  deleted thing - undo, audit, billing. Nothing here does. Logs and
  statistics for a deleted warehouse describe a layout that no longer
  exists.
- Every read path in the app would have to grow an `isDeleted` term, and
  that is one forgotten filter away from leaking deleted data into a
  listing. The cost of getting hard delete wrong is bounded and obvious; the
  cost of getting soft delete wrong is silent.
- **No transaction.** MongoDB transactions require a replica set, which this
  deployment does not. Ordering carries the guarantee instead: children are
  deleted before the parent, so if the process dies part-way through, the
  warehouse still exists, its remaining children are still reachable and
  still owned, and repeating the request finishes the job. The reverse order
  produces exactly the orphans this fixes.

Transactions are not used anywhere else either, and that is a decision
rather than an omission. The places that need atomicity get it from a
single-document operation with the state check expressed as a filter
(`Order.bulkWrite` with `status: { $in: predecessorsOf(next) }`), which is
atomic in MongoDB without any of the deployment requirements a transaction
carries.

Indexes supporting these paths: `{warehouseId, status}` on robots and
orders, `{warehouseId, assignedRobot, status}` on orders (the "what was this
robot carrying?" query, which runs inside a delete request), and
`{warehouseId, createdAt}` on logs.

---

## 10. Known limitations

Stated rather than hidden - each of these is a live constraint, not a bug
waiting to be filed.

1. **Single process.** The engine cache, the tick loops and the warehouse
   lock are all in-memory and per-process. Running two backend instances
   against one database would give each its own engines, its own tick loops
   and its own locks for the same warehouse - two simulations writing over
   each other. Horizontal scaling needs warehouse-to-instance affinity (or a
   shared engine), and neither exists today.
2. **In-flight movement is not resumed** across a restart or a layout
   change. Robots come back at rest and orders are requeued. This is a
   deliberate simplification; the alternative is persisting paths and
   replanning against a world that may have changed.
3. **Dynamic obstacles are not persisted.** They vanish on restart. They are
   a runtime hazard, not part of the saved layout.
4. **Delivered orders keep a reference to a robot that may since have been
   deleted.** That is history, and history is not rewritten - but it does
   mean `assignedRobot` on a completed order can dangle.
5. **Recovery runs on a cache miss**, which means a plain read (listing a
   warehouse's obstacles, say) can trigger a reconciliation write. It is
   idempotent and correct, but it is a side effect on a `GET`.
6. **Automatic ticks are dropped, not deferred**, when the previous tick is
   still running. A consistently slow warehouse therefore runs slower than
   its configured cadence rather than falling behind and catching up. The
   loop counts skipped ticks (`skippedTicks` in `simulation:status`) so this
   is observable rather than silent.
7. **The tick loop stops when the last watcher leaves.** A simulation is not
   a background job here; nothing runs for an empty room.
8. **`clearError` is manual.** A robot whose battery reached zero away from
   a charger cannot move to one under its own power and stays in `error`
   until a person clears it. Its order is released so the *order* is not
   stuck, but the robot is.
9. **No wall-clock guarantees.** `deltaSeconds` is whatever the caller
   passes (bounded to 10s), not measured elapsed time, so a lagging server
   produces a slower simulation rather than a jumpier one.

---

## Verifying this

| What | How |
|---|---|
| Unit + integration suite | `npm test` (backend) |
| Concurrency, recovery and state machines specifically | `npm run test:reliability` |
| Against a **real** MongoDB | `MONGO_URI=mongodb://127.0.0.1:27017/warehouse-sim-scratch npm run check:reliability` |

The last one exists because the jest suite mocks Mongoose - the right
trade-off for hundreds of fast tests, but it cannot catch a disagreement
between what the code assumes a document looks like and what MongoDB
actually stores. It found the fractional-position bug in §6 that the mocked
suite missed. It drops the database it runs against, and refuses to start
unless the database name looks disposable.

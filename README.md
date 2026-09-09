# Warehouse Robot Fleet Simulation

A real-time, browser-based simulation of an autonomous warehouse robot
fleet: grid-based navigation, A\* pathfinding, multi-robot coordination,
order management, and a live analytics dashboard - built end to end with
a Node/Express/MongoDB/Socket.IO backend and a React/Vite frontend.

This project was built **incrementally, one milestone at a time**,
following a 15-milestone development plan from an empty repository to a
tested, documented, deployable application. This README is the finished
state; the full build history - what each milestone added, the trade-offs
made along the way, and the bugs caught and fixed as the project grew -
is preserved in [`docs/DEVELOPMENT_LOG.md`](./docs/DEVELOPMENT_LOG.md).

## Live Demo

🔗 [Click here to view the live demo](https://warehouse-robot-simulation-b6uc.vercel.app/)

[Demo]

## What it does

- **Design a warehouse floor plan** on an editable grid - shelves,
  charging stations, docks, obstacles - by hand or with a procedural
  generator (aisle/shelf/charging/dock layouts at three density presets).
- **Spawn a fleet of robots** and watch them autonomously fulfill
  orders: pathfind to a pickup, carry it to a delivery point, and head to
  the nearest reachable charging station on their own once their battery
  runs low.
- **Choose how orders get assigned** between five scheduling strategies
  (first-come-first-served, nearest robot, least busy, round robin,
  priority queue) and watch the fleet behave differently in real time.
- **Everything is live**, synced over Socket.IO to every open tab/browser
  watching the same warehouse - not polled, not client-driven; the
  simulation runs on the server whether or not anyone's currently looking
  at it.
- **Dynamic obstacles** (human workers, temporary blockages, broken-down
  robots, construction zones) that robots detect and route around
  automatically, with deadlock avoidance when robots contend for the same
  space.
- **Watch the A\* search itself** - step through open/closed sets, the
  search tree, and the final path frame by frame in the AI Visualisation
  Panel.
- **Save, browse, and reload named layouts**; export/import as JSON;
  inspect a persisted log of everything that happened.

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/API.md`](./docs/API.md) | Every REST endpoint and Socket.IO event, with request/response shapes |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | System diagram, component responsibilities, the tick loop, the real-time event bus, known limitations, security notes |
| [`docs/SIMULATION_ARCHITECTURE.md`](./docs/SIMULATION_ARCHITECTURE.md) | The simulation core: which system owns which state, the tick mechanism, the per-warehouse concurrency model, the robot and order state machines, restart recovery, Socket.IO resynchronisation, A* cost controls |
| [`docs/FRONTEND_ARCHITECTURE.md`](./docs/FRONTEND_ARCHITECTURE.md) | The dashboard: server-owned vs client state, the connection lifecycle, error and empty states, the three testing layers |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | Threat model, authentication and authorization model, and what is deliberately out of scope |
| [`docs/ER_DIAGRAM.md`](./docs/ER_DIAGRAM.md) | MongoDB collections and how they relate |
| [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) | Step-by-step: MongoDB Atlas → backend (Render/Railway) → frontend (Vercel/Netlify) |
| [`docs/DEVELOPMENT_LOG.md`](./docs/DEVELOPMENT_LOG.md) | The full milestone-by-milestone build history |

## Stack

| Layer     | Choice                                            |
|-----------|---------------------------------------------------|
| Backend   | Node.js, Express, Mongoose (MongoDB), Socket.IO    |
| Frontend  | React 18, Vite, Socket.IO client                   |
| Database  | MongoDB (local or Atlas)                           |

## Project structure

```
warehouse-robot-simulation/
├── backend/
│   ├── src/
│   │   ├── config/        # env loading, DB connection
│   │   ├── controllers/   # request handlers (one file per resource)
│   │   ├── domain/        # Order + robot lifecycles, shared by the engine and the REST layer
│   │   ├── engine/
│   │   │   ├── grid/         # Backend cell-type mirror + Warehouse->grid adapter
│   │   │   ├── obstacles/    # Dynamic obstacle manager (human workers, construction zones, etc.)
│   │   │   ├── orders/       # Order generator + pickup->delivery coordinator
│   │   │   ├── pathfinding/  # A* engine, priority queue, heuristics
│   │   │   ├── robots/       # Robot Engine: movement, state machine, battery, task queue
│   │   │   └── scheduling/   # 5 selectable order->robot assignment strategies
│   │   ├── events/         # simulationEvents - the bus decoupling the engine from Socket.IO
│   │   ├── middleware/    # error handling, request validation
│   │   ├── models/        # Mongoose schemas: Warehouse, Robot, Order, Statistics, Log,
│   │   │                   #   User, RefreshToken, VerificationToken, SecurityEvent, SimulationLease
│   │   ├── routes/        # Express routers (one file per resource)
│   │   ├── services/      # simulationManager, orderService, tickRunner - bridge the pure engines
│   │   │                   #   to MongoDB; authService, mailer, securityAudit, instanceLease
│   │   ├── sockets/       # Socket.IO setup: rooms, tickLoopManager (server-owned tick loop)
│   │   ├── utils/         # asyncHandler, pagination
│   │   ├── app.js         # Express app (middleware + routes)
│   │   └── server.js      # HTTP server entry point
│   ├── scripts/
│   │   └── benchmark.js   # Fleet-scale tick-throughput benchmark, no MongoDB required
│   ├── tests/             # Jest + Supertest - 644 tests
│   ├── .env.example
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── api/            # REST client, ApiError normalisation, realtime.js (socket lifecycle
│   │   │                   #   manager), telemetry.js (client error reporting)
│   │   ├── engine/
│   │   │   ├── grid/       # Pure grid engine: create/resize/set/serialize
│   │   │   └── grid/warehouseGenerator.js  # Procedural aisle/shelf/charging/dock layout generator
│   │   ├── state/
│   │   │   ├── simulationReducer.js  # Every mutation of server-owned state (robots, orders, obstacles, running)
│   │   │   ├── useConnection.js      # API reachability and realtime status, reported separately
│   │   │   ├── useSimulationGrid.js  # Grid + tool + selection + backend sync + saved-layouts state
│   │   │   ├── useLiveSimulation.js  # Socket.IO-driven robots/orders/obstacles/notifications, heatmap/history
│   │   │   ├── usePathVisualization.js  # AI Visualisation Panel: start/goal picking, traced A* run, step playback
│   │   │   └── useKeyboardShortcuts.js  # Global tool/erase/simulation/pick-mode shortcuts
│   │   ├── components/
│   │   │   ├── layout/     # AppShell, TopNav, ShortcutsHelp overlay
│   │   │   ├── sidebar/    # Fleet roster (live robot list) / tool palette
│   │   │   ├── simulation/ # SimulationCanvas frame + GridCanvas (viewport, input) + renderScene.js
│   │   │   │               #   (the drawing itself, as pure functions - so it can be tested)
│   │   │   ├── common/     # ErrorBoundary, shared loading/empty/error/banner feedback
│   │   │   └── panels/     # Simulation + warehouse controls, obstacles, statistics, orders, notifications, AI visualisation, saved layouts, logs, chart
│   │   ├── utils/          # format.js - status labels and number formatting shared by every panel
│   │   ├── theme.js        # Color tokens mirrored from index.css (for canvas)
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── tests/              # Vitest + Testing Library - 395 tests; tests/e2e is Playwright
│   ├── index.html
│   ├── vite.config.js      # Vite + Vitest config (single file)
│   ├── playwright.config.js
│   ├── .env.example
│   └── package.json
└── docs/                   # API.md, ARCHITECTURE.md, SIMULATION_ARCHITECTURE.md,
                            #   FRONTEND_ARCHITECTURE.md, ER_DIAGRAM.md, DEPLOYMENT.md,
                            #   DEVELOPMENT_LOG.md, SECURITY.md
```

## Running locally

### 1. Backend

```bash
cd backend
cp .env.example .env   # adjust MONGO_URI if needed
npm install
npm run dev            # nodemon, or `npm start` for a plain run
```

The API listens on **http://localhost:5000**. It starts and serves
`/api/health` immediately even without MongoDB running — useful for local
frontend work — but logs a clear warning if it can't reach the database.
Point `MONGO_URI` at a real local MongoDB instance or an Atlas cluster to
exercise the Warehouse/Robot/Order/Statistics/Log endpoints.

Run the backend test suite (mocked models, no live database required):

```bash
cd backend
npm test
```

Run the fleet-scale benchmark (real engine, no database required):

```bash
cd backend
npm run benchmark          # 50 robots, 200 ticks
node scripts/benchmark.js 100 200   # or specify robot/tick counts
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

The dashboard is served at **http://localhost:5173** and its dev server
proxies `/api/*` and `/socket.io` to the backend, so the browser only
talks to one origin. No environment variables are needed for local dev -
see [`frontend/.env.example`](./frontend/.env.example) and
[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) for the two build-time
variables a production deployment needs instead.

Run the frontend checks - lint, type inference over plain JS, 395 unit and
integration tests, and a production build - none of which need a database:

```bash
cd frontend
npm run verify             # all four, in order
npm test                   # just the tests (~35s)
npm run test:coverage      # currently 88% of statements
```

The production build also generates the frontend's Content-Security-Policy
from `VITE_API_URL` and emits it as a meta tag plus `_headers` and
`vercel.json` - see
[`scripts/securityHeaders.js`](./frontend/scripts/securityHeaders.js).

The end-to-end suite is separate because it is the one layer that needs a
real stack - the backend, MongoDB, and a real browser - which is also what
makes it the only layer that can catch a cookie that is never set or a
handshake CORS rejects. Playwright starts the Vite server itself:

```bash
cd frontend
npm run test:e2e:install   # once - downloads Chromium
npm run test:e2e           # 17 specs against http://localhost:5173
```

Point `E2E_BASE_URL` at a staging deployment to run the same specs there;
each one registers its own account and cleans up after itself.
See [`docs/FRONTEND_ARCHITECTURE.md`](./docs/FRONTEND_ARCHITECTURE.md#6-testing)
for what each layer is responsible for.

### 3. Verify the connection

Open http://localhost:5173 — the status pill in the top-right of the nav
bar should read **SYSTEM ONLINE** (green) once both servers are running. It
polls `/api/health` every 10 seconds and also reflects the live Socket.IO
connection state.

### Grid controls

| Action              | Input                                              |
|---------------------|-----------------------------------------------------|
| Place an object      | Pick a tool in the sidebar, then click or click-drag on the grid |
| Erase                | Right-click a cell (any tool), or pick the Eraser tool |
| Select a cell         | Pick the Select tool, then click a cell            |
| Zoom                 | Mouse wheel, or the +/− buttons in Simulation Controls |
| Pan                  | Click-drag (Select tool), or hold **Space** and drag with any tool |
| Reset the view       | "Reset View" button                                |
| Resize the grid       | Set Rows/Cols in Simulation Controls, then "Resize" |
| Save/load a layout    | "Export JSON" / "Import JSON", or the Saved Layouts panel |
| Generate a layout     | "Generate Layout" in Simulation Controls, pick a density |
| Sync layout to the server | "Sync Layout to Server" in Simulation Controls (needs a running backend + MongoDB) |
| Change assignment strategy | "Assignment Strategy" dropdown, appears after syncing |
| Keyboard shortcuts    | Click "⌨ Shortcuts" in the top bar, or press **?** |

## Deploying

See [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) for the full walkthrough:
MongoDB Atlas → backend on Render or Railway → frontend on Vercel or
Netlify, including every environment variable each step needs and a
post-deploy checklist.

## Known limitations

This is a demo/portfolio project, and the limitation lists in the docs are
maintained as a real record rather than as a disclaimer: each entry says
what the constraint is, and the ones that have been closed say what
replaced them. Start with
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#known-limitations), which
links to the detailed lists in
[`SIMULATION_ARCHITECTURE.md`](./docs/SIMULATION_ARCHITECTURE.md#10-known-limitations),
[`SECURITY.md`](./docs/SECURITY.md#11-known-limitations) and
[`FRONTEND_ARCHITECTURE.md`](./docs/FRONTEND_ARCHITECTURE.md#7-known-limitations).

**It is a multi-user application.** Accounts, per-user data isolation,
resource-level authorization, authenticated Socket.IO, rate limiting and
CSRF protection landed in the security phase; password reset, email
verification, TOTP multi-factor authentication, warehouse sharing
(`viewer`/`editor` collaborators), an administrative surface and a security
audit trail landed after it.
[`docs/SECURITY.md`](./docs/SECURITY.md) documents the whole posture,
including the threat model and what is still deliberately out of scope -
federated identity, per-device session management, and the infrastructure
controls that belong to Render/Vercel/Atlas rather than to this code.

**The simulation survives a restart.** Robots come back on the route they
were driving, dynamic obstacles come back with them, and a tick advances by
measured elapsed time rather than by an assumed cadence. One backend
instance owns a warehouse's tick loop at a time, so a second instance
running against the same database declines to simulate it rather than
writing over the first.

**The frontend is tested, including the canvas - up to a point.** 395
Vitest unit and integration tests and 17 Playwright end-to-end specs cover
the state reducer, the connection lifecycle, every panel, the drawing
decisions behind the floor plan, and the full operator journey through a
real browser. What no test here can check is whether those drawing calls
produce the right *image*: that is screenshot diffing, and it is the honest
residue of what used to be "rendering regressions are caught by looking".
[`docs/FRONTEND_ARCHITECTURE.md`](./docs/FRONTEND_ARCHITECTURE.md) covers
the client's state ownership rules and the limits of each testing layer.

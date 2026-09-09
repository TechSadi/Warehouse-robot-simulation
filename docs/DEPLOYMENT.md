# Deployment Guide

This deploys the three pieces as separate services, per the project's
original brief:

- **Database** → MongoDB Atlas
- **Backend** → Render or Railway
- **Frontend** → Vercel or Netlify

Deploy in that order - each step needs something from the one before it.

## 1. MongoDB Atlas

1. Create a free cluster at [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas).
2. **Database Access** → add a database user (username/password - not
   your Atlas account login).
3. **Network Access** → add `0.0.0.0/0` (allow from anywhere). Render and
   Railway don't publish static outbound IPs on their free/starter tiers,
   so IP allowlisting isn't practical here - this is the standard
   trade-off for that hosting combination, not an oversight. If your host
   gives you a static IP, allowlist that instead.
4. **Connect → Drivers** → copy the connection string. It looks like:
   ```
   mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
   ```
5. Add a database name before the `?`: `.../warehouse-sim?retryWrites=...`.
   Mongoose creates the database and its collections automatically on
   first write - nothing to run manually.

Keep this connection string handy for step 2.

## 2. Backend (Render or Railway)

Both platforms work the same way here: point them at the `backend/`
subdirectory of this repo, set the environment variables below, and let
them build and start it.

**Render**
- New → Web Service → connect the repo.
- Root directory: `backend`
- Build command: `npm install`
- Start command: `npm start`
- Instance type: the free tier works, but see the note on `TICK_INTERVAL_MS`
  below - free tiers spin down after inactivity, which stops any running
  simulation until the next request wakes it back up.

**Railway**
- New Project → Deploy from GitHub repo.
- Root directory: `backend` (Settings → set the service's root).
- Railway auto-detects `npm start` from `package.json` - no separate
  build command needed.

### Backend environment variables

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables the production Morgan log format, hides stack traces from error responses, and trusts the platform's reverse proxy for `req.ip` (see [`ARCHITECTURE.md`](./ARCHITECTURE.md)) |
| `MONGO_URI` | the Atlas connection string from step 1 | Include the database name |
| `CLIENT_ORIGINS` | your deployed frontend's URL, e.g. `https://your-app.vercel.app` | **Required in production** - the server refuses to boot without it rather than falling back to an open CORS policy. Comma-separated if you have more than one (e.g. a preview deployment URL too). Drives both REST CORS and the Socket.IO CORS check. Exact origin only: scheme + host, no trailing slash or path |
| `JWT_ACCESS_SECRET` | 48 random bytes, base64url | **Required in production.** Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Must be at least 32 characters |
| `JWT_REFRESH_SECRET` | a **different** 48 random bytes | **Required in production.** Two keys, not one, so a leaked access secret cannot also mint refresh tokens |
| `PORT` | usually not needed | Render/Railway set this automatically; the app reads `process.env.PORT` and falls back to `5000` locally |
| `SOCKET_PATH` | leave unset | Only needed if you're proxying Socket.IO through a non-default path |
| `TICK_INTERVAL_MS` | leave unset | Only needed to change the 500ms tick cadence |
| `BCRYPT_ROUNDS`, `JWT_*_TTL_SECONDS`, `MAX_FAILED_LOGINS`, `LOGIN_LOCKOUT_SECONDS`, `COOKIE_*` | leave unset | Sensible defaults; see [`SECURITY.md`](./SECURITY.md#9-environment-secrets) |

Set the two JWT secrets **before** the first deploy of this version: the
server throws on startup if either is missing or under 32 characters,
rather than silently using a default that would be identical on every
deployment. Rotating either one signs every user out - which is the
intended emergency response to a suspected leak.

Once deployed, note the backend's public URL (e.g.
`https://your-backend.onrender.com`) - the frontend needs it next.

### Migrating data created before the security phase

`Warehouse.ownerId` is required, and warehouses created before this
version have none - so they match no ownership query and are invisible
through the API. Nothing is lost; the documents are untouched in Atlas.

Register an account through the deployed app, then run the backfill
against the production connection string (dry run first):

```
cd backend
MONGO_URI="<atlas uri>" node scripts/backfill-ownership.js --email you@example.com
MONGO_URI="<atlas uri>" node scripts/backfill-ownership.js --email you@example.com --apply
```

It only sets `ownerId` on warehouses that have none - it never reassigns
an owned one, never touches robots/orders/statistics/logs (those inherit
ownership through the warehouse), and never deletes anything. Take an
Atlas snapshot before `--apply` regardless.

### Verify the backend

```
curl https://your-backend.onrender.com/api/health
```
should return `{ "success": true, "data": { "status": "ok", "database": "connected", ... } }`.
If `database` says anything other than `connected`, double check the
Atlas connection string and network access list from step 1.

`/api/health` is the only route that answers without a session. Every
other endpoint now returns `401` unauthenticated, so this is also a quick
way to confirm auth is live:

```
curl -i https://your-backend.onrender.com/api/warehouses     # expect 401
```

## 3. Frontend (Vercel or Netlify)

Both platforms auto-detect a Vite project.

**Vercel**
- New Project → import the repo.
- Root directory: `frontend`
- Framework preset: Vite (auto-detected)
- Build command: `npm run build` (default)
- Output directory: `dist` (default)

**Netlify**
- New site → import the repo.
- Base directory: `frontend`
- Build command: `npm run build`
- Publish directory: `frontend/dist`

### Frontend environment variables

Set these in the platform's dashboard before the first build - Vite
bakes them into the built JS at build time, so setting them *after*
deploying doesn't retroactively update an already-built bundle; you'd
need to trigger a rebuild:

| Variable | Value |
|---|---|
| `VITE_API_URL` | your backend's URL, e.g. `https://your-backend.onrender.com` |
| `VITE_SOCKET_URL` | the same URL |

See [`frontend/.env.example`](../frontend/.env.example) - without these,
the built app tries to call its own origin for the API, which doesn't
exist there (see [`ARCHITECTURE.md`](./ARCHITECTURE.md) for why local dev
doesn't need this: Vite's dev-server proxy handles it implicitly there,
but a production build has no such proxy).

`VITE_API_URL` now does one more job: the build generates the frontend's
Content-Security-Policy from it and emits it as a `<meta>` tag in
`index.html` plus `dist/_headers` (Netlify, Cloudflare Pages) and
`dist/vercel.json` (Vercel). Getting it wrong therefore no longer only
breaks the API calls - it produces a policy that *blocks* them, which shows
up in the browser console as a CSP violation rather than a network error.
The meta tag works with no hosting configuration at all, so a deployment
gets a real policy by default; the header files exist because
`frame-ancestors` and `X-Frame-Options` cannot be set from a meta tag. See
[`scripts/securityHeaders.js`](../frontend/scripts/securityHeaders.js).

On **Vercel**, point the project's output directory at `frontend/dist` so
the generated `vercel.json` is picked up. On **Netlify**, `_headers` is
found automatically in the publish directory.

### Verify the frontend

Open the deployed frontend URL. The connection-status pill in the top bar
should read "Connected" within a few seconds - if it doesn't, open the
browser console and check for a CORS error (mismatched `CLIENT_ORIGINS`
on the backend) or a failed request to the wrong origin (missing/wrong
`VITE_API_URL`).

### Optional backend environment variables worth setting

None of these throw on startup, and each silently disables something if
left unset:

| Variable | Without it |
|---|---|
| `MAIL_TRANSPORT` + `MAIL_WEBHOOK_URL` | Password reset and email verification generate tokens that are never delivered. Production defaults to `none` deliberately - a reset link written to a log nobody reads is not a delivered email |
| `APP_BASE_URL` | Emailed links point at the first `CLIENT_ORIGINS` entry, which is usually right |
| `RATE_LIMIT_STORE` | Defaults to `mongo` in production, which is what you want as soon as there is more than one instance |
| `SIMULATION_LEASES` | On by default. Leave it on unless you are certain the deployment is single-instance |

The full list, with the reasoning for each default, is in
[`backend/.env.example`](../backend/.env.example) and
[`SECURITY.md`](./SECURITY.md#9-environment-secrets).

## Post-deploy checklist

- [ ] `GET /api/health` on the backend returns `{ "status": "ok" }` (it
      deliberately reports nothing else without a session; sign in and use
      `GET /api/health/details` to check the database connection)
- [ ] The frontend loads and shows "Connected" in the top bar
- [ ] Creating a grid layout and clicking "Sync Layout to Server" succeeds
- [ ] Spawning a robot and clicking "Start Simulation" shows it moving in
      real time
- [ ] Opening the app in a second browser tab shows the *same* simulation
      state (proves the server-owned tick loop and Socket.IO rooms are
      working across clients, not just within one tab)
- [ ] The browser console shows no Content-Security-Policy violations - if
      it does, `VITE_API_URL` did not match the backend origin at build
      time
- [ ] "Forgot password" produces a delivered email (or, with
      `MAIL_TRANSPORT=console`, a link in the backend log)

## A note on free-tier hosting and the tick loop

Render/Railway's free tiers spin the service down after a period of
inactivity and cold-start it on the next request. Since the simulation's
tick loop lives on the server (see [`ARCHITECTURE.md`](./ARCHITECTURE.md#the-tick-loop)),
a spun-down instance means any "running" simulation actually stopped
ticking during the downtime - the frontend will reconnect and resync
automatically once the backend wakes back up (see the reconnect handling
in `useLiveSimulation.js`), but there will be a visible gap. This is a
free-tier hosting characteristic, not a bug in the app; a paid/always-on
tier doesn't have this issue.

Two things soften it. A robot's destinations are persisted, so the fleet
comes back on the work it was doing rather than idle with its orders
requeued. And a tick advances by *measured* elapsed time rather than by its
nominal cadence, capped at `MAX_TICK_DELTA_SECONDS` - so the first tick
after a wake-up catches up a little instead of pretending no time passed,
without the fleet teleporting across the warehouse. How much time was
dropped past the cap is reported as `laggedSeconds` in `simulation:status`.

"Keep running when nobody is watching" (`background: true`) does **not**
help here: it stops the loop being shut down when the last client leaves,
and has nothing to say about the process being stopped underneath it.

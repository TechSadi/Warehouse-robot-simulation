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
| `CLIENT_ORIGINS` | your deployed frontend's URL, e.g. `https://your-app.vercel.app` | Comma-separated if you have more than one (e.g. a preview deployment URL too) - this drives both REST CORS and the Socket.IO CORS check |
| `PORT` | usually not needed | Render/Railway set this automatically; the app reads `process.env.PORT` and falls back to `5000` locally |
| `SOCKET_PATH` | leave unset | Only needed if you're proxying Socket.IO through a non-default path |
| `TICK_INTERVAL_MS` | leave unset | Only needed to change the 500ms tick cadence |

Once deployed, note the backend's public URL (e.g.
`https://your-backend.onrender.com`) - the frontend needs it next.

### Verify the backend

```
curl https://your-backend.onrender.com/api/health
```
should return `{ "success": true, "data": { "status": "ok", "database": "connected", ... } }`.
If `database` says anything other than `connected`, double check the
Atlas connection string and network access list from step 1.

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

### Verify the frontend

Open the deployed frontend URL. The connection-status pill in the top bar
should read "Connected" within a few seconds - if it doesn't, open the
browser console and check for a CORS error (mismatched `CLIENT_ORIGINS`
on the backend) or a failed request to the wrong origin (missing/wrong
`VITE_API_URL`).

## Post-deploy checklist

- [ ] `GET /api/health` on the backend returns `database: "connected"`
- [ ] The frontend loads and shows "Connected" in the top bar
- [ ] Creating a grid layout and clicking "Sync Layout to Server" succeeds
- [ ] Spawning a robot and clicking "Start Simulation" shows it moving in
      real time
- [ ] Opening the app in a second browser tab shows the *same* simulation
      state (proves the server-owned tick loop and Socket.IO rooms are
      working across clients, not just within one tab)

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

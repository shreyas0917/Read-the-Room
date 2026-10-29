# Read the Room

A real-time party game for 2–8 phones. Everyone answers a playful question from 1 to 10 in secret, then predicts the room's average. Closest guess wins the round.

- **Frontend:** React 19 + TypeScript + Vite 8
- **Backend:** one Cloudflare Worker + one Durable Object per room (authoritative state, WebSockets, alarms)
- **No accounts, no paid APIs, no external services.** Fonts are self-hosted.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173 — real Workers runtime + Durable Objects locally
```

Open the URL in a normal window and a private window (or on your phone on the same network with `npm run dev -- --host`) to play with two devices.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with the Worker + Durable Object running in workerd |
| `npm run build` | Strict typecheck (`tsc -b`) + production build to `dist/` |
| `npm run preview` | Serve the production build in workerd |
| `npm test` | Unit tests (engine, scoring, redaction, protocol) |
| `npm run test:integration` | Starts the app (10× faster timers) and plays real multi-client games over WebSockets, including a full runtime restart |
| `npm run test:e2e` | Builds, serves, and plays a full game in two browser contexts with Playwright |
| `npm run deploy` | Build and deploy to Cloudflare |

## Architecture

```
shared/     pure, deterministic, unit-tested — no I/O
  rules.ts      constants (durations, limits, scoring numbers)
  protocol.ts   state + wire types, strict message validation
  engine.ts     (state, action, now) → state | error   — the state machine
  scoring.ts    round scoring + ranking
  redact.ts     per-player projection: the only way state leaves the server
  prompts.ts    question bank
  rng.ts        seeded PRNG
worker/
  index.ts      HTTP routes: create room, room info, WebSocket upgrade
  room.ts       Room Durable Object: auth, persistence, alarms, broadcast
src/          React client (useRoom hook + one screen per phase)
tests/        unit · integration (real WebSockets) · e2e (Playwright)
```

- **The server is authoritative.** Clients send intents; the engine validates them, the Durable Object persists the result to SQLite-backed storage and pushes a personalised snapshot to every socket.
- **Consistency:** all state changes happen in one synchronous block on synchronous KV storage, so events can't interleave mid-update. Outgoing messages wait for the write to be durable.
- **Timers** use a single Durable Object alarm set to the next deadline / grace expiry. They keep working through hibernation and restarts.
- **Identity:** server-issued UUID + 256-bit resume token; only its SHA-256 hash is stored.

Details: [docs/RULES.md](docs/RULES.md) · [docs/PROTOCOL.md](docs/PROTOCOL.md)

## Deploying

Live: **https://read-the-room.read-the-room.workers.dev**

Needs a free Cloudflare account. The free plan supports SQLite-backed Durable Objects, which this project uses.

```powershell
npx wrangler login              # opens a browser once
npx wrangler deploy --dry-run   # inspect bindings/vars before uploading
npm run deploy                  # build + wrangler deploy

# Verify the live deployment (the local-only restart scenario is skipped automatically)
$env:BASE_URL = "https://read-the-room.read-the-room.workers.dev"
node tests/integration/run.mjs
npx playwright test
Remove-Item Env:BASE_URL
```

A brand-new `workers.dev` subdomain can take a minute or two to get its TLS certificate; until then HTTPS handshakes fail.

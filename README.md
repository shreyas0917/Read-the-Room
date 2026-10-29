# Read the Room

A real-time party game for 2–8 phones where the answer key is your friends. Everyone rates a playful question from 1 to 10 in secret, then predicts the room's average. The closest guess wins the round.

Every third round is an **Echo Round**, a question built from what the room already answered: *how many of you went above 6?*, *which question split the room most?*, or (only for players who opted in) *who said 10?* See [docs/ECHO_ROUNDS.md](docs/ECHO_ROUNDS.md). The game ends with awards and a shareable **Room Report** (highlights and a round-by-round recap, built only from what everyone already saw).

**Play:** https://read-the-room.read-the-room.workers.dev

- **Frontend:** React 19 + TypeScript + Vite 8
- **Backend:** one Cloudflare Worker + one Durable Object per room (authoritative state, WebSockets, alarms)
- **No accounts, no paid APIs, no external services.** Fonts are self-hosted; sound effects are synthesized in the browser (mute from the top bar).

## How to play

1. One person creates a room; everyone else joins on their own phone with the 4-letter code, QR code or invite link (2–8 players).
2. Each round: rate a playful question from 1 to 10 in secret, then predict the room's average (yours included). Closer guess = more points (up to 100); within 0.3 is a **+50 Bullseye**; the lone most extreme answer is named the **+25 Wildcard**.
3. Every third round is an **Echo Round** about earlier answers: *higher or lower*, *room pattern*, or (only for players who switched consent on) *who said it?*.
4. The game ends with awards and a shareable Room Report. Full rules: [docs/RULES.md](docs/RULES.md).

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
| `npm test` | Unit tests (engine, scoring, Echo Rounds, deadline timing, redaction, Room Report, protocol) |
| `npm run test:integration` | Starts the app (2× faster timers via `CLOUDFLARE_ENV=test`) and plays real multi-client games over WebSockets, including every Echo mode and full runtime restarts mid-game and mid-Echo |
| `npm run test:e2e` | Playwright: a full 2-device game + Room Report against the production build, a 320 px no-overflow run with max-length names, connection recovery and zero-CSP-violation checks, and a 4-device "Who said it?" game (consent, privacy, keyboard, reconnects) against a local seedable fixture server. Don't run `npm run dev` at the same time: local runtimes share `.wrangler/state` and can contend for its SQLite files |
| `node tests/upgrade/v1-to-v2.mjs <oldCommit> <scratchDir>` | Real storage-upgrade test: runs the old commit in a temporary worktree, saves a mid-game room, hands its Durable Object storage to `HEAD`, resumes every player and plays on |
| `node showcase/render-cover.mjs` | Re-render `showcase/cover.png` (1800 × 1200) from `showcase/cover.html` |
| `npm run deploy` | Build and deploy to Cloudflare |

### Test-only Wrangler environments

| Env | Used by | Settings |
|---|---|---|
| `test` | integration suite | timers ×0.5, `ALLOW_TEST_SEED` |
| `e2e` | `*.fixture.spec.ts` browser tests | real timers, `ALLOW_TEST_SEED` |

With `ALLOW_TEST_SEED=1`, `POST /api/rooms?seed=N` fixes the room's PRNG seed so a test can know which Echo mode comes up. Production never defines it (check with `npx wrangler deploy --dry-run`), so `?seed` is ignored there and seeds come from `crypto.getRandomValues`. A seed only decides prompt order and Echo selection, never answers, tokens or identities.

## Architecture

```
shared/     pure, deterministic, unit-tested — no I/O
  rules.ts      constants (durations, limits, scoring numbers)
  protocol.ts   state + wire types, strict message validation
  engine.ts     (state, action, now) → state | error   — the state machine
  echo.ts       deterministic Echo Round generation
  scoring.ts    round + Echo scoring, ranking
  report.ts     end-of-game awards, highlights and recap (public data only)
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
- **Hardening:** deadlines enforced on arrival, idle sockets can't lock a room, a client watchdog for dead connections, a protocol-version banner for stale tabs, per-IP lookup limits and a strict CSP. See [docs/READINESS_REVIEW.md](docs/READINESS_REVIEW.md).

Details: [docs/RULES.md](docs/RULES.md) · [docs/ECHO_ROUNDS.md](docs/ECHO_ROUNDS.md) · [docs/PROTOCOL.md](docs/PROTOCOL.md) · [docs/READINESS_REVIEW.md](docs/READINESS_REVIEW.md) · [docs/PLAYTEST_CHECKLIST.md](docs/PLAYTEST_CHECKLIST.md) · [docs/SHOWCASE.md](docs/SHOWCASE.md)

## Deploying

Live: **https://read-the-room.read-the-room.workers.dev** (version `b2ad83bf`: Echo Rounds, awards, Room Report, Phase D hardening and the alarm-loop hotfix)

Rollback to the previous version: `npx wrangler rollback <version-id> --name read-the-room` (see `npx wrangler deployments list`).

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

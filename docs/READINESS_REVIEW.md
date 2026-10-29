# Production-readiness review (Phase D)

Reviewed against `main` at `b5fd71f` (identical to production version `44ff590f`: the local build produces the same bundle hash, `index-x70peI5C.js`). Nothing was run against the live service except single read-only page/header requests and one room creation.

**Legend.** *Confirmed* = reproduced (locally) or directly observed. *Potential* = follows from code or docs but not demonstrated. *Fixed* = changed in this phase, with a regression test.

## Incident 2026-10-29: free-plan row-write quota exhausted (critical, fixed locally)

**What happened.** Right after deploying Phase D (version `1dca6943`), `POST /api/rooms` returned HTTP 500 / error 1101. `wrangler tail` showed `Exceeded allowed rows written in Durable Objects free tier.` Every room write fails until the daily limit resets at 00:00 UTC.

**Root cause (in every version since Milestone 1, not introduced by Phase D).** `nextWakeTime` scheduled a host hand-over wake-up whenever the host was disconnected, even when nobody could take over. Once all players had left, which is how every game ends, that wake time stayed in the past. The Durable Object therefore re-armed its alarm every 50 ms and wrote state on each tick until the room was deleted 10 minutes later: about 1,200 alarms a minute (reproduced in a unit simulation), ≈ 12,000 writes per finished game (≈ 24,000 rows on the previous version, which wrote two rows per commit). A few finished test games on production used up the 100,000 rows/day.

**Why the review missed it.** The capacity estimate above counted writes per *played* game and assumed alarms fire only at real deadlines; local runtimes have no quotas, so nothing failed locally.

**Fix.** (1) The engine only schedules the hand-over wake-up when a successor exists. (2) Safety net in the Durable Object: an alarm whose tick changes nothing writes nothing and never re-arms a time that is already due. **Tests:** `tests/unit/alarms.test.ts` simulates the alarm loop for abandoned rooms (final screen, mid-game, spectator-only, lobby) and asserts that after every tick the next wake-up is in the future. Four of these fail against the deployed engine and pass with the fix.

**Deployed.** Hotfix version `b2ad83bf` went live on 2026-10-29 at about 14:58 UTC (rollback target `1dca6943`). Room creation keeps failing with the quota error until the daily reset at 00:00 UTC; the fix stops it from recurring.

**Lesson.** Any timer that re-arms itself must be tested for "does it make progress?", not just "does it fire".

## Summary

| # | Finding | Type | Severity | Status | Needed before showcase? |
|---|---|---|---|---|---|
| 1 | Idle sockets can lock a room (new players **and** reconnects refused) | Confirmed | Medium | **Fixed** | Yes |
| 2 | Submissions accepted after the deadline until the alarm fires | Confirmed | Low–Medium (fairness) | **Fixed** | Yes |
| 3 | No CSP / nosniff / framing protection on the page | Confirmed (live headers) | Low (defence in depth) | **Fixed** | Recommended |
| 4 | A tab that misses a server close can sit on a dead socket forever | Confirmed (locally, evicted sockets) | Medium | **Fixed** (client watchdog) | Yes |
| 5 | Old tabs blank when the server adds a phase (seen in the Phase B rollout) | Confirmed | Low | **Fixed for future deploys** (unknown-phase screen + protocol version banner) | Yes |
| 6 | Unlimited room lookups / socket upgrades per IP | Potential | Low–Medium (quota burn, code scanning) | **Mitigated** (per-isolate 120/min/IP) | Recommended |
| 7 | Keep-alive pings wake the Durable Object and count as billed messages | Confirmed (docs + code) | Low (cost) | **Fixed** (runtime auto-response) | No, but cheap |
| 8 | Resume-token table rewritten on every action | Confirmed (code) | Low (row-write quota) | **Fixed** (write only when changed) | No, but cheap |
| 9 | No host kick / room lock: anyone with a code can take lobby seats | Potential | Medium **if codes are posted publicly** | Not changed | Only if codes go public |
| 10 | Room codes are 4 letters (279,841) | Potential | Low | Not changed | No |
| 11 | Two-player averages reveal the other answer | Known design limit | Info | Documented in rules | No |

## Details

### 1. Socket squatting — confirmed, fixed
**Evidence.** Against a local server: 32 WebSockets that never sent `hello` made every further connection fail; 12 s later it was still blocked (the cap is per room and nothing expired idle sockets). Existing players who dropped could not reconnect.
**Fix.** At the 32-socket cap, the oldest socket that never identified itself is evicted, so a real player always gets in. Identified sockets are bounded by seats (≤ 16, one live socket per seat). No idle timeout otherwise, because someone still typing their name also holds an unidentified socket.
**Test.** Integration `idle unauthenticated sockets can't lock players out`: 40 idle sockets, then a guest joins, the host reconnects, the evicted socket is no longer served, and a slow joiner (11 s before hello) still joins.

### 2. Late submissions — confirmed, fixed
**Evidence.** New unit tests `tests/unit/timing.test.ts` failed on the old engine: an answer, prediction, Echo pick or host *Next* sent at or after the deadline was accepted if it beat the alarm.
**Fix.** `applyAction` first applies any deadline that is already due, then judges the action against the phase the game has really reached (`wrong_phase` if late).

### 3. Security headers — confirmed, fixed
**Evidence.** Live `GET /` returned only `Content-Type` and `Cache-Control`.
**Fix.** `public/_headers` (Workers Static Assets) sets CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, same-origin + `wss:` connects), `nosniff`, `X-Frame-Options: DENY`, a referrer policy and a permissions policy. API responses set `nosniff` in code, because `_headers` doesn't apply to Worker responses (per Cloudflare docs). Verified locally on `/`, SPA routes and assets; an e2e test plays a round with zero CSP violations. `style-src` keeps `'unsafe-inline'` because React style props need it. The game renders no user HTML (names are text nodes), so this is defence in depth, not a fix for a known XSS.

### 4. Dead sockets — confirmed, fixed
**Evidence.** In the local runtime, a socket the server closes from another request's context never receives a close frame; the client sees an open, silent socket. Mobile networks produce the same half-open state.
**Fix.** Client watchdog in `src/net/useRoom.ts`: hello/resume must be answered within 6 s, and silence over 45 s (pongs arrive every 25 s) triggers a reconnect. **Test:** Playwright swallows the first socket's traffic and the client rejoins on its own; with the watchdog disabled the test fails (mutation check).
**Residual edge case.** If a hello *did* reach the server but the reply was lost, the retry gets "name taken" until the orphan seat expires (60 s in the lobby). Rare; the player can pick another name.

### 5. Version skew — confirmed, fixed for future deploys
**Evidence.** After the Phase B deploy, open Phase A tabs rendered nothing during Echo Rounds.
**Fix.** The server's `welcome` carries `protocol: 2`. A client seeing a different version shows "A new version of the game is live — Refresh"; an unknown phase shows a refresh screen instead of a blank one. Tabs already open on the *current* production build don't have this yet, but **this release adds no new phase**, so they keep working.

### 6. Lookups / enumeration — potential, mitigated
Code lookups and socket upgrades had no limit. Each costs a Worker request and a Durable Object request, so a script could burn the free daily quota (see below) or scan codes. Now 120 per minute per IP per isolate (a classroom behind one IP needs ~2 per player per join). It is best-effort: Cloudflare runs many isolates, so a distributed attacker isn't stopped. A real fix needs Cloudflare rate-limiting rules on a custom domain (not available on `workers.dev`) or a paid plan. **No paid change made.**

### 7–8. Cost fixes — confirmed
Cloudflare docs: incoming WebSocket messages are billed 20:1 as Durable Object requests; `setWebSocketAutoResponse` replies "will not incur additional wall-clock time". Pings are now auto-responses. The token table was rewritten with every state write; it is now written only when it changes.

### 9. No host kick / room lock — potential, not changed
Anyone who knows a code can join a lobby (taking up to 8 player seats) or spectate mid-game. Spectators only ever see public data. This matters only if room codes are shared publicly (e.g. posted on a showcase page). If that's planned, add a host *kick* and *lock room* — small, but a new feature, so it's left for your decision.

### 10. Room codes
23⁴ = 279,841 codes. A random guess hits one of N live rooms with probability N/279,841; with the lookup limit, sweeping every code from one IP and isolate takes ~39 h. Acceptable for a party game; 5 letters (6.4 M) would be a one-line change if needed.

### Verified correct (no change needed)
- **Authorization and validation.** Every action is validated by the pure engine (host-only actions, phase, participant, duplicate, value range); the protocol parser rejects unknown types and extra fields. Covered by unit and integration tests.
- **Simultaneous actions.** One Durable Object per room processes events one at a time, with all state changes in one synchronous block on synchronous storage. Integration tests fire submissions from all clients at once.
- **Reconnect and recovery.** Resume tokens are 256-bit, stored as SHA-256 only, sent once to their owner. Seats survive refreshes, disconnects, runtime restarts (tested mid-Echo) and the v1→v2 storage upgrade (tested against the real Phase A code).
- **Host migration, departures, rematch, abandonment.** Unit-tested; abandoned rooms delete their storage after 10 min.
- **Consent.** Enforced on the server at generation; mutation-tested in unit and browser tests; others only see a count.
- **Leaks.** Every integration/e2e message is scanned for hidden fields; the subject's identity only appears in `echo_reveal` snapshots.
- **Room Report sharing.** Text only, built from public data, never sent anywhere automatically.
- **Cross-site WebSocket use.** The socket has no ambient credentials (no cookies); tokens live in this origin's localStorage, so another site can't act as a player.

## Cloudflare free plan: limits and estimated capacity

Limits (Cloudflare docs, fetched during this review): Workers 100,000 requests/day; Durable Objects 100,000 requests/day, 13,000 GB-s/day, 100,000 SQLite rows written/day, 5 GB stored; incoming WebSocket messages count 20:1; alarms count as requests; static assets are free and unlimited. Limits reset 00:00 UTC; past a limit, "further operations of that type will fail with an error".

**Estimate for one 8-player, 9-round game (~7 min).** These are calculations from the code, not measurements:

| Resource | Per game | Free-plan games/day |
|---|---|---|
| Worker requests (create + 8 × lookup + 8 × upgrade) | ~17 | ~5,800 |
| Durable Object requests (RPCs, upgrades, ~150 messages ÷ 20, ~30 alarms) | ~55 | ~1,800 |
| SQLite rows written (≈ 1 per state write; was ≈ 2) | ~200 (was ~390) | ~500 (was ~260) |
| Duration, worst case (awake all game, 128 MB) | ~52 GB-s | ~250 |

Assumptions: one row per KV `put` (Cloudflare's docs don't state the KV row count), reconnects ignored, the duration bound assumes no hibernation during play. **Realistic capacity is a few hundred full games a day**, far above showcase traffic. The binding limits are duration and row writes. Check the real numbers in the Cloudflare dashboard (Workers & Pages → read-the-room → Metrics) after your playtests. No load test was run.

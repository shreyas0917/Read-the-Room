# Showcase kit

Drafts for presenting Read the Room. Nothing here is published or submitted automatically. Edit freely; it's written in your voice.

**Live:** https://read-the-room.read-the-room.workers.dev

## Submission fields

**Title:** Read the Room

**Description (422 / 500 characters):**
> Read the Room is a party game for 2–8 phones where the answer key is your friends. Answer playful 1–10 questions in secret, predict the room's average, and score by reading people. Every third round is an Echo Round built from what the room already said, including an opt-in “Who said it?”. The hard part was real-time sync and privacy: hidden answers never leave the server. Next: custom question packs and host controls.

**Cover image:** `showcase/cover.png` (1800 × 1200, 3:2), rendered from `showcase/cover.html`; see the brief below.

## What makes it different (one paragraph)

Most party games have a right answer. Read the Room doesn't: you rate a silly question in secret, then guess what the *whole room* said, so you score by knowing your friends, not by knowing facts. The twist is **Echo Rounds**. Every third round, the game builds a new question from the room's own earlier answers ("Back in round 2, how many of you went above 6?", "Which question split the room most?", and, only for players who opted in, "Someone said 10. Who was it?"). The longer you play, the more the game is about *this* group.

## 90-second demo script

Two windows side by side (laptop + phone, or a normal + a private window). A third device helps for Who said it?.

| Time | Show | Say |
|---|---|---|
| 0:00 | Landing page | "A party game where the answer key is your friends. Everyone plays on their own phone. No app, no login." |
| 0:08 | Create a room; big code + QR | "Make a room, friends scan this or type the code." |
| 0:15 | Phone joins; both in the lobby; point at the rules and the consent switch | "Rules are on screen. This switch is consent for one special round; more on that later." |
| 0:22 | Start (6 rounds). Round 1: both answer | "Rate the question 1 to 10 in secret. Nobody sees your answer." |
| 0:32 | Predict | "Now guess the room's average, yours included." |
| 0:40 | Reveal: dots drop, average line, points, Bullseye | "Anonymous dots, the average, and points for how close you got. Within 0.3 is a Bullseye." |
| 0:50 | Skip to round 3: Echo Round | "Every third round is an Echo Round: a question made from what this room already answered." |
| 1:00 | Echo reveal: the old dot plot comes back with the threshold | "It brings back the round-2 dots. Memory and reading people." |
| 1:10 | (Optional, 3+ devices) Who said it? subject screen vs guesser | "Only players who opted in can be the answer; only they know it's them." |
| 1:18 | Final: winner, awards, Room Report, **Copy report** | "Awards, highlights and a shareable recap, built only from what everyone already saw." |
| 1:28 | Refresh a phone mid-game (if time) | "Refresh, lock the phone, switch networks: you keep your seat." |

Tip: for a tight recording, pick 6 rounds and have the host tap **Next round** on each reveal.

## Cover-art brief

- **Size:** 3:2, at least 1200 px wide. Deliver 1800 × 1200 PNG.
- **Text (large, legible at thumbnail size):** "Read the Room" (wordmark: "Read *the* Room", with "the" italic, tilted, lime) and the tagline "The answer key is your friends." Optional small line: "A party game for 2–8 phones".
- **Visual:** midnight-purple background (`#140a2e`, soft glow from the top), electric lime (`#c6ff3d`) accents, violet (`#8f7cff`) secondary. Show 2–3 phone frames with real screens: a reveal dot plot, an Echo Round question, the Room Report. A row of dots with a dashed lime "average" line is the signature motif.
- **Avoid:** tiny UI text as the main message, stock photos, gradients that muddy contrast, other brands' logos.
- **Fonts:** Bricolage Grotesque (display) + Inter (body), the same as the game.

## Architecture summary (portfolio / interview)

> **Read the Room** is a real-time multiplayer web game on Cloudflare's edge. A React + TypeScript client talks over WebSockets to one **Durable Object per room**, the single authority for that room's state. All game logic lives in a **pure, deterministic engine** (`(state, action, now) → state`) shared by client types and server, so rules are unit-tested without a network, and the Durable Object is a thin shell that authenticates sockets, persists state to SQLite-backed storage, schedules phase deadlines with alarms and broadcasts a **per-player redacted view**. That projection is the only way state leaves the server, which is how hidden answers stay hidden: tests scan every message for secret fields, and mutation tests prove they catch leaks.

Talking points:
- **Correctness under concurrency:** one object per room processes events serially; every change is a single synchronous block on synchronous storage, and outgoing messages wait for durable writes.
- **Recovery:** 256-bit resume tokens (only hashes stored) restore a seat after refreshes, dropped networks and runtime restarts. Tested by killing the runtime mid-round, and by upgrading a room saved by the previous release.
- **Deterministic Echo Rounds:** generated from persisted history with a seeded PRNG and stored with the round, so reconnects can't change a question. Browser tests derive a seed by replaying the planned game through the shared engine.
- **Privacy by design:** answers are anonymous aggregates. "Who said it?" requires per-player consent that others only see as a count, and the named subject plays a decoy pick so the "locked in" strip gives nothing away.
- **Testing:** ~100 unit tests, multi-client WebSocket integration tests against the real Workers runtime, and Playwright tests with up to four browser contexts, 320 px phones, keyboard-only play and CSP checks.
- **Cost-aware:** static assets free, keep-alives answered by the runtime without waking the object, storage rows written only when they change. It fits comfortably in Cloudflare's free plan.

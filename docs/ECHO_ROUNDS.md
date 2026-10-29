# Echo Rounds — design

Echo Rounds turn the room's own earlier answers into new questions. They are
the game's signature mechanic: the longer you play, the more the game is
about *this* room.

## When

- Rounds 3, 6, 9 and 12 (every round whose number is divisible by 3) are Echo Rounds — so every game also **ends** on one.
- An Echo Round needs eligible history (see each mode). If no mode is eligible — e.g. both earlier rounds were voided — that round is played as a **regular round** instead, using the prompt reserved for it.
- Prompts: the game still reserves one prompt per round number, so a fallback never runs out.

## Lifecycle

```
… reveal ──▶ beginRound(n)            n % 3 == 0 and a challenge is eligible?
                 ├─ yes ─▶ ECHO (20 s) ──▶ ECHO_REVEAL (12 s / host Next) ──▶ next round or FINAL
                 └─ no  ─▶ ANSWER → PREDICT → REVEAL   (regular round)
```

- The challenge is generated **once**, inside `beginRound`, and stored in `current.echo` in Durable Object storage. Reconnects and runtime restarts read the stored challenge; nothing is regenerated.
- Generation is a pure function of persisted state: `generateEcho(state, n)` uses only `history`, `players`, and a PRNG seeded from `(room seed, game number, round number)`. Same state in → same challenge out (tested, including a JSON round-trip that mimics storage).
- ECHO ends early once every connected participant has submitted (min. 2), exactly like ANSWER/PREDICT. Disconnected players never block it; the deadline always advances it.
- Participants: every seated player at round start. Spectators can watch but not submit.

## Modes

Each mode is a single tap. The submission is `{ t: "echo", choice: <integer> }`; what `choice` means depends on the mode.

### 1. Higher or Lower (`count`)
> *Back in round 2 — "Rate pineapple on pizza." How many of the 4 answers were **higher than 6**?*

- Source: one earlier **non-voided regular** round with ≥ 2 answers and at least two different answer values.
- Threshold `t` (1–9) is chosen so the true count is strictly between 0 and the number of answers when possible.
- `choice` ∈ 0…answerCount. Exact → **100**, off by one → **50**, otherwise 0.
- Uses only data already shown: the anonymous dot plot of that round.

### 2. Room Pattern (`pattern`)
> *Which question had the **highest average** / **lowest average** / **split the room most**?* — three earlier prompts.

- Source: three earlier non-voided regular rounds (needs ≥ 3 eligible, so it can't appear before round 6).
- "Split the most" = largest population standard deviation of that round's answers.
- Generated only when the winner is unambiguous: it must beat the runner-up by ≥ 0.1. Otherwise another metric / set of rounds is tried; if none qualifies the mode is ineligible.
- `choice` ∈ 0…2. Correct → **100**.
- Uses only revealed aggregates (averages and anonymous counts).

### 3. Who Said It? (`who`) — opt-in only
> *Back in round 4 — "How loud is your sneeze?" — someone answered **10**. Who was it?*

This is the only mode that attaches a name to an answer, so it is gated on **explicit, informed, per-player consent**:

- **Off by default.** In the lobby each player has their own switch: *"Let 'Who said it?' name me"*, with the consequence spelled out next to it. Nobody can turn it on for someone else.
- Consent can only change in the **lobby**; it is locked once a game starts, so it always covers every answer in that game.
- Players who opted in see an **"On the record"** badge on every answer screen.
- Others only ever see *how many* players opted in, never who — so the switch itself doesn't narrow the suspects.
- Eligible subject: a consenting, still-seated player whose answer in a non-voided regular round with **≥ 3 answers** was **unique** in that round (nobody else gave the same number) and wasn't already named as that round's Wildcard. Each player is the subject at most once per game.
- Options: every player who answered that round and is still seated. You can't pick yourself.
- **The subject plays too** — they get the same screen ("It was you — pick someone to throw them off") and make a decoy pick, so the "locked in" strip never reveals who the subject is.
- Scoring: correct guess → **100**. The subject earns **+25 per player who guessed wrong**, max 100.
- If the subject leaves the room before the reveal, the round is cancelled (no points) so a departed player is never named.

### Choosing a mode
Among the eligible modes, the PRNG picks one that hasn't been used yet this game; if all have been used, any eligible mode.

## Client-visible data

| Phase | Everyone | Only you |
|---|---|---|
| ECHO | mode, question data (source prompt, threshold/value, options), who has submitted | your own pick; "it was you" if you're the Who-said-it subject |
| ECHO_REVEAL | correct answer, everybody's pick and points; `pattern`: average/spread/counts of the three rounds; `count`: the source round's counts; `who`: the subject's name | — |

Never sent: the correct answer during ECHO, the `who` subject during ECHO (except to the subject), any answer→player mapping other than the consented `who` subject.

## Failure handling

| Situation | Result |
|---|---|
| No eligible mode | Round is played as a regular round |
| Nobody submits | Deadline advances; everyone scores 0 |
| Malformed / out-of-range choice, picking yourself | `bad_message` / `invalid_value` |
| Second submission | `already_submitted` |
| Wrong phase, spectator, non-host *Next* | `wrong_phase` / `not_participant` / `not_host` |
| `who` subject leaves | Round cancelled, no points |
| Player leaves mid-echo | Their pick is discarded |
| Fewer than 2 seated players | Game ends early (unchanged) |
| Rooms saved by the previous version | Migrated on load (missing fields get safe defaults) |

## Accessibility
- Options are a WAI-ARIA radio group labelled by the question: one Tab stop, arrow keys / Home / End move focus and selection (skipping your own disabled option in Who Said It), Enter / Space select, Tab reaches **Lock it in**. The selected option also shows a ✓, so selection isn't colour-only.
- Each phase change is announced through a polite live region.

## Testing
- Unit: `tests/unit/echo.test.ts` (generation, eligibility, scoring, privacy, determinism, migration).
- Integration: every mode over real WebSockets, mid-Echo reconnect, runtime restart mid-Echo.
- Browser: `tests/e2e/who-said-it.fixture.spec.ts` plays Who Said It with four browser contexts. It finds a room seed that yields Who Said It in round 3 by replaying the planned game through the shared engine (mode selection depends only on seed, seats and history), then creates the room with that seed on a local `e2e`-env server. It checks consent privacy, the subject-only instruction, the decoy pick, keyboard-only selection with a visible focus ring, refresh and offline reconnects, scoring, and that no WebSocket frame ever carried the subject or the answer before the reveal.

## Privacy boundaries — honestly

- "Anonymous" means the game never **labels** an answer with a name, except Wildcard (announced in the rules) and opted-in Who Said It.
- Aggregates can still **imply** answers. With 2 players, the average plus your own answer tells you the other answer exactly; with more players, unusual combinations (e.g. everyone answered the same) do too. Echo Rounds only reuse aggregates that were already revealed, so they add no new inference beyond what the original reveal allowed — but they don't make aggregates private either.
- Who Said It needs ≥ 3 answers in the source round so it is never a forced guess, and the "locked in" strip is identical for the subject and everyone else.

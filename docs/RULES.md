# Game rules (as enforced by the server)

Source of truth: `shared/rules.ts`, `shared/scoring.ts`, `shared/engine.ts`.

## Room
- 2–8 players; up to 8 extra spectators. 4-letter codes from `ABCDEFGHJKMNPQRSTUVWXYZ` (no I, L, O).
- Names: 1–16 characters after trimming; control/format characters stripped; unique per room (case-insensitive).
- First joiner is host. Host can change round count (6 / 9 / 12, default 9) and start once ≥ 2 players are **connected**.

## Round
| Phase | Length | Ends early when |
|---|---|---|
| ANSWER — rate the prompt 1–10 (whole numbers) | 20 s | every connected participant has answered (min. 2 answers) |
| PREDICT — guess the room average 1.0–10.0 (tenths) | 20 s | every connected participant has predicted (min. 2) |
| REVEAL — anonymous dot plot, scores | 12 s | host taps *Next* |

- One submission per phase. Answers and predictions **cannot be changed** once locked.
- Participants are the seated players at round start. Spectators (mid-game joiners) cannot submit.
- Players who miss the answer deadline may still predict; they're excluded from the average.
- Fewer than 2 answers at the answer deadline → round **voided** (skips PREDICT, no points).

## Scoring (full precision; points rounded once per component)
- Target = mean of every valid answer this round, **including the predictor's own**.
- Prediction points = `round(100 × max(0, 1 − |prediction − mean| / 3))`.
- **Bullseye +50** when `|prediction − mean| ≤ 0.3` (1e-9 tolerance).
- **Wildcard +25** to the single answer furthest from the mean, if that distance ≥ 2. Ties for furthest → nobody. Never possible with 2 answers. The Wildcard is named on the reveal — the rules screen says so before anyone answers.
- No prediction → 0 prediction points (a Wildcard bonus still applies).
- Display rounds averages to 1 decimal; scoring never uses the rounded value.

## Final ranking
Score desc, then bullseyes desc; players equal on both share a rank (1, 1, 3).

## Privacy
- Nobody sees another player's answer or prediction before the reveal — only *that* they submitted.
- After the reveal, answers appear only as anonymous counts per value. Predictions and points are public.
- With exactly 2 answers, your own answer plus the average implies the other answer. That's arithmetic, not a leak.

## Connections
- **Refresh / reconnect:** the browser keeps a resume token (localStorage, per room). Reconnecting restores the same seat, score and host status.
- **Disconnected players never block a phase.** Deadlines always advance.
- **Mid-game:** a disconnected player keeps their seat and score for the rest of the game.
- **Lobby:** a disconnected player's seat is freed after **60 s**.
- **Host:** if the host is disconnected for **20 s** (or leaves), the earliest-seated connected player becomes host.
- **Leave:** removes the player immediately; their unrevealed submissions are discarded. If fewer than 2 seated players remain, the game ends early.
- **Rematch:** host-only from the final screen. Scores reset, spectators are promoted to players (up to 8), new prompts.
- **Abandoned rooms:** deleted after **10 min** with nobody connected.

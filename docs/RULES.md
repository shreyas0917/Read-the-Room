# Game rules (as enforced by the server)

Source of truth: `shared/rules.ts`, `shared/scoring.ts`, `shared/engine.ts`, `shared/echo.ts`. Echo Round design: [ECHO_ROUNDS.md](ECHO_ROUNDS.md).

## Room
- 2–8 players; up to 8 extra spectators. 4-letter codes from `ABCDEFGHJKMNPQRSTUVWXYZ` (no I, L, O).
- Names: 1–16 characters after trimming; control/format characters stripped; unique per room (case-insensitive).
- First joiner is host. Host can change round count (6 / 9 / 12, default 9) and start once ≥ 2 players are **connected**.
- Each player has their own **"Who said it?" consent switch** in the lobby: off by default, changeable only in the lobby, shown to others only as a count.

## Regular round
| Phase | Length | Ends early when |
|---|---|---|
| ANSWER — rate the prompt 1–10 (whole numbers) | 20 s | every connected participant has answered (min. 2 answers) |
| PREDICT — guess the room average 1.0–10.0 (tenths) | 20 s | every connected participant has predicted (min. 2) |
| REVEAL — anonymous dot plot, scores | 12 s | host taps *Next* |

- One submission per phase. Answers and predictions **cannot be changed** once locked.
- Participants are the seated players at round start. Spectators (mid-game joiners) cannot submit.
- Players who miss the answer deadline may still predict; they're excluded from the average.
- Fewer than 2 answers at the answer deadline → round **voided** (skips PREDICT, no points).

## Echo Round (rounds 3, 6, 9, 12)
| Phase | Length | Ends early when |
|---|---|---|
| ECHO — one tap about earlier rounds | 20 s | every connected participant has picked (min. 2) |
| ECHO_REVEAL — correct answer, picks, points | 12 s | host taps *Next* |

- Built from earlier **non-voided regular rounds** only. If no mode is eligible, the round is played as a regular round.
- The question is generated once when the round starts and stored; reconnects and restarts can't change it.
- One pick, locked once made. No pick → 0. Echo Rounds are never voided (except a cancelled Who Said It, below).

| Mode | Question | Eligible when | Points |
|---|---|---|---|
| Higher or lower | "Back in round N, how many of the K answers were higher than T?" | an earlier round with ≥ 2 distinct answers | exact 100, off by one 50 |
| Room pattern | "Which question had the highest average / lowest average / split the room most?" (3 options) | ≥ 3 earlier rounds and a winner ahead by ≥ 0.1 | correct 100 |
| Who said it? | "Back in round N, someone answered V. Who was it?" | a **consenting** player's answer that was unique in a round with ≥ 3 answers, and not that round's Wildcard; each player at most once per game | correct 100; the subject (who makes a decoy pick) gets +25 per wrong guess, max 100 |

- A mode not yet used this game is preferred.
- You can't pick yourself in Who Said It. If its subject leaves before the reveal, the round is cancelled with no points and nobody is named.

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
- Nobody sees another player's answer, prediction or Echo pick before the reveal — only *that* they submitted.
- After the reveal, answers appear only as anonymous counts per value. Predictions, Echo picks and points are public.
- Names are attached to answers in exactly two cases, both announced in advance: the **Wildcard** (in the rules), and the **Who said it?** subject (only players who switched consent on).
- During Who Said It, only the subject is told it's them; the subject also picks, so the "locked in" strip looks the same for everyone.
- **Aggregates are not a privacy guarantee.** With exactly 2 answers, your own answer plus the average implies the other answer; unusual distributions can imply more. Echo Rounds only reuse aggregates already revealed, so they add no new inference, but they don't remove it either.

## Connections
- **Refresh / reconnect:** the browser keeps a resume token (localStorage, per room). Reconnecting restores the same seat, score and host status.
- **Disconnected players never block a phase.** Deadlines always advance.
- **Mid-game:** a disconnected player keeps their seat and score for the rest of the game.
- **Lobby:** a disconnected player's seat is freed after **60 s**.
- **Host:** if the host is disconnected for **20 s** (or leaves), the earliest-seated connected player becomes host.
- **Leave:** removes the player immediately; their unrevealed submissions are discarded. If fewer than 2 seated players remain, the game ends early.
- **Rematch:** host-only from the final screen. Scores reset, spectators are promoted to players (up to 8), new prompts.
- **Abandoned rooms:** deleted after **10 min** with nobody connected.

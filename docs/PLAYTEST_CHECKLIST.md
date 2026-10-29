# Playtest checklist

For real people on real devices. Automated tests cover a lot (see README), but not real phones, real networks, Safari, Firefox, screen readers or how it *feels*. Copy this file per session.

**Session:** date ______ · build/version ______ · URL ______ · tester(s) ______

Mark each row ✅ pass / ❌ fail / ➖ not tested, and write what you saw.

## Devices and browsers
| Device / OS | Browser | Network | Players |
|---|---|---|---|
| | | Wi-Fi / mobile data | |
| | | | |

Aim for at least: one iPhone (Safari), one Android (Chrome), one laptop (Chrome or Edge), one Firefox, one on mobile data.

## 1. Joining
| # | Do this | Expect | Result / notes |
|---|---|---|---|
| 1.1 | Open the URL on a laptop, enter a name, **Create a room** | Lobby with a big 4-letter code and a QR code | |
| 1.2 | Phone: scan the QR code | Join screen for that room; enter name → lobby | |
| 1.3 | Phone: type the code on the landing page instead | Same lobby | |
| 1.4 | Phone: **Share invite link** | Share sheet (phone) or "Link copied" (laptop) | |
| 1.5 | Try a name someone already has | "Someone in this room already has that name." | |
| 1.6 | Type a wrong code | "No room called XXXX…" | |
| 1.7 | Open a 9th player | "This room is full." | |
| 1.8 | Join after the game has started | Spectator notice; plays in the next game | |

## 2. Two-player game (6 rounds)
| # | Do this | Expect | Result / notes |
|---|---|---|---|
| 2.1 | Host picks 6 rounds, starts | Both see Round 1 of 6, the same question and the same countdown | |
| 2.2 | One player locks in | Other sees "1/2 locked in"; the locked player sees "Waiting for …" | |
| 2.3 | Both answer and predict | Reveal: dot plot, the room's average, points, "+50 Bullseye" if within 0.3 | |
| 2.4 | Round 1 reveal | One-line scoring key explains the points | |
| 2.5 | Round 3 | Echo Round explainer card, then a "Higher or lower" question about round 1 or 2 | |
| 2.6 | Final | Winner, standings, awards (if earned), Room Report with all 6 rounds | |

## 3. Four to eight players (9 rounds)
| # | Do this | Expect | Result / notes |
|---|---|---|---|
| 3.1 | 4+ players, 9 rounds | Rounds 3, 6 and 9 are Echo Rounds | |
| 3.2 | Room Pattern appears (round 6 or 9) | Three earlier questions; reveal shows their averages and spreads | |
| 3.3 | A lone extreme answer (e.g. 10 when others say 4–6) | Named as the Wildcard, +25 | |
| 3.4 | Everyone answers similarly | No Wildcard named | |
| 3.5 | 8 players | Lobby, strip and scores fit on a phone without sideways scrolling | |

## 4. Who said it? and consent
| # | Do this | Expect | Result / notes |
|---|---|---|---|
| 4.1 | Lobby: look at the "Who said it?" switch | Off by default; explains the consequence | |
| 4.2 | Turn it on for 2–3 players | Everyone sees only the count ("2 of 4 players are on the record"), never who | |
| 4.3 | Start the game | Switch can't be changed mid-game; opted-in players see "On the record." on answer screens | |
| 4.4 | Play 9 rounds with 3+ players | A Who said it? round appears; only the subject sees "Shh, it was you" | |
| 4.5 | Non-subject: try to work out who it is from the screen | No hint (the subject also locks in; strip looks identical) | |
| 4.6 | Reveal | "It was ___", guessers +100 if right, subject +25 per wrong guess | |
| 4.7 | Play 9 rounds with **nobody** opted in | No Who said it? round ever | |

## 5. Disconnects, refresh, timeouts
| # | Do this | Expect | Result / notes |
|---|---|---|---|
| 5.1 | Refresh mid-round | Same seat, score and screen | |
| 5.2 | Lock the phone for 30 s, unlock | Brief "reconnecting" banner, then back in the game | |
| 5.3 | Switch phone between Wi-Fi and mobile data mid-round | Reconnects by itself | |
| 5.4 | Airplane mode for 10 s | "You're offline…" banner; reconnects after | |
| 5.4b | Join on a slow connection (a weak real signal, or Chrome DevTools → Network → "Slow 3G") | Joins on the first try; never "Someone already has that name" for your own name (see READINESS_REVIEW #4) | |
| 5.5 | One player doesn't answer | Round moves on when the timer ends; "Time's up" on their screen | |
| 5.6 | Nobody answers | Round voided ("Not enough answers"), game continues | |
| 5.7 | Host closes their tab | After ~20 s someone else becomes host | |
| 5.8 | A player taps **Leave** | They disappear; game continues if ≥ 2 remain | |
| 5.9 | Host: **Play again with this room** | Back to lobby, scores reset, spectators can now play | |

## 6. Accessibility and preferences
| # | Do this | Expect | Result / notes |
|---|---|---|---|
| 6.1 | Laptop, keyboard only: create, start, answer (arrow keys on the slider), predict, Echo pick (Tab, arrows, Space, Tab, Enter) | Everything reachable; visible lime focus ring | |
| 6.2 | 🔊 button | Mutes / unmutes; remembered after reload | |
| 6.3 | OS "reduce motion" on | No dot-drop or count-up animation; game still clear | |
| 6.4 | Phone text size at maximum / browser zoom 200% | Text wraps; buttons still usable; no sideways scroll | |
| 6.5 | VoiceOver (iOS) or TalkBack (Android) | Phase changes announced; sliders and options have labels | |
| 6.6 | Narrowest phone you have (or 320 px in devtools) | No clipped text or sideways scroll on any screen | |

## 7. Room Report
| # | Do this | Expect | Result / notes |
|---|---|---|---|
| 7.1 | **Copy report**, paste into a notes app | Winner, standings, awards, highlights, every round; no answers | |
| 7.2 | Phone: **Share…** | System share sheet with the same text | |
| 7.3 | **Preview the text** | Matches what was copied | |

## 8. Error and edge states
| # | Do this | Expect | Result / notes |
|---|---|---|---|
| 8.1 | Open an invite link for a room that has closed (everyone left > 10 min ago), or a made-up code like `/r/QQQQ` | "Room not found" with a way back to the start | |
| 8.2 | Open the same seat in two tabs on one device | Older tab: "Open in another tab" with **Use it here instead**; the game keeps working in the newer tab | |
| 8.3 | Tap **Leave**, then **Cancel** in the confirm dialog | Nothing happens; tap Leave and confirm → "You left the room" | |
| 8.4 | Double-tap **Lock in** quickly | One submission; the button shows "Locking in…" then the locked state | |
| 8.5 | Let a phase run out while on the answer screen without locking in | Button turns to "Time's up"; round moves on | |
| 8.6 | Host leaves mid-game (Leave) with 3+ players | Someone else becomes host; game continues | |
| 8.7 | Everyone but one player leaves mid-game | Game ends early; final screen says "Game ended early" | |

## 9. After deploying a new version (only when a release adds a new screen or phase)
| # | Do this | Expect | Result / notes |
|---|---|---|---|
| 9.1 | Keep a tab open across a deploy, then keep playing | Banner "A new version of the game is live — Refresh"; Refresh keeps your seat and score | |

## Issues found
| # | Severity (blocker / major / minor) | Device + browser | Steps | Expected | Actual |
|---|---|---|---|---|---|
| | | | | | |

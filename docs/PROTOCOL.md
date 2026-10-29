# Client ↔ server protocol

Transport: one WebSocket per device at `GET /api/rooms/:code/ws`. JSON text frames, ≤ 1 KB. Types: `shared/protocol.ts`.

## HTTP
| Route | Response |
|---|---|
| `POST /api/rooms` | `201 { code }` · `429` if > 10 rooms/min from one IP |
| `GET /api/rooms/:code` | `{ exists, phase?, players? }` · `400` bad code |
| `GET /api/rooms/:code/ws` | `101` upgrade · `404` no such room · `503` room busy (> 32 sockets) |

## Handshake
```
client → { t: "hello", name }                       new player
server → { t: "welcome", playerId, token, resumed: false }
client → { t: "resume", playerId, token }           returning player
server → { t: "welcome", playerId, resumed: true }  | { t: "error", code: "bad_token" }
server → { t: "state", view }                       after every accepted change
```
The token (32 random bytes, base64url) is sent **once**, only to its owner. The server stores only `sha256(token)`. A newer socket for the same seat replaces the old one (`{ t: "bye", reason: "replaced" }`).

## Client messages (after joining)
`answer {value}` · `predict {value}` · `echo {choice}` · `consent {value}` · `start` · `next` · `settings {rounds}` · `play_again` · `leave` · `ping`

- `echo.choice`: integer 0–16 on the wire; the engine then checks it against the current challenge (count: 0…answers, pattern: 0…2, who: an option index that isn't you).
- `consent.value`: boolean; lobby only (`wrong_phase` otherwise).

Unknown types, unknown extra fields, wrong value types and out-of-range values are rejected with `bad_message`. Every action is then checked by the engine for permissions and phase (`not_host`, `wrong_phase`, `already_submitted`, `not_participant`, `invalid_value`…).

## State snapshot (`ClientView`)
Personalised per socket by `shared/redact.ts`: phase (`lobby`, `answer`, `predict`, `reveal`, `echo`, `echo_reveal`, `final`), round, `deadline` + `serverNow` (clients derive a clock offset; the client clock is never trusted), players with `submitted` flags, the viewer's own answer/prediction/Echo pick and consent, the consent *count*, anonymous reveal counts, the Echo question (`echo`; its `result` only in `echo_reveal`), standings and recap.

Persisted state carries a schema version (`v: 2`). Rooms saved by v1 are migrated on load.

## Limits
40 messages / 10 s per socket → `rate_limited`; 80 → socket closed (1008).

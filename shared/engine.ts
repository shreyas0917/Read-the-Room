// Deterministic game engine. No I/O, no clocks, no randomness except the
// seeded RNG: (state, action, now) → new state | error. The Durable Object
// is a thin shell that authenticates sockets, feeds actions in, persists the
// result and broadcasts redacted views.
//
// State machine:
//   lobby ──start──▶ answer ──▶ predict ──▶ reveal ──▶ (next round) … ──▶ final
//                       └─(<2 answers)────────▲
//   every 3rd round, when eligible:  echo ──▶ echo_reveal ──▶ (next round)
//   final ──play_again──▶ lobby
// A phase ends at its deadline, or early once every *connected* participant
// has submitted. Disconnected players never block a phase.

import type { Player, RoomState, RoundRecord, ErrorCode, Phase } from "./protocol";
import { isValidAnswer, isValidPrediction, normalizeName } from "./protocol";
import { PROMPTS } from "./prompts";
import { generateEcho, isValidEchoChoice } from "./echo";
import { mixSeed, mulberry32, shuffle } from "./rng";
import {
  ABANDON_MS,
  DEFAULT_ROUNDS,
  DURATIONS,
  ECHO_EVERY,
  HOST_GRACE_MS,
  LOBBY_GRACE_MS,
  MAX_PLAYERS,
  MAX_SPECTATORS,
  MIN_PLAYERS,
  ROUND_OPTIONS,
  type RoundCount,
} from "./rules";
import { scoreEcho, scoreRound, ZERO_SCORE } from "./scoring";

export type EngineAction =
  | { type: "join"; playerId: string; name: string }
  | { type: "connect"; playerId: string }
  | { type: "disconnect"; playerId: string }
  | { type: "leave"; playerId: string }
  | { type: "settings"; playerId: string; rounds: RoundCount }
  | { type: "start"; playerId: string }
  | { type: "answer"; playerId: string; value: number }
  | { type: "predict"; playerId: string; value: number }
  | { type: "echo"; playerId: string; choice: number }
  | { type: "consent"; playerId: string; value: boolean }
  | { type: "next"; playerId: string }
  | { type: "play_again"; playerId: string }
  | { type: "tick" };

export type EngineResult = { ok: true; state: RoomState } | { ok: false; error: ErrorCode };

export const AVATAR_COUNT = 16;

export function createRoom(code: string, seed: number, now: number, timerScale = 1): RoomState {
  return {
    v: 2,
    code,
    createdAt: now,
    lastActivity: now,
    emptySince: now,
    hostId: null,
    settings: { rounds: DEFAULT_ROUNDS },
    timerScale,
    seed: seed >>> 0,
    gameNumber: 1,
    phase: "lobby",
    deadline: null,
    round: 0,
    prompts: [],
    current: null,
    history: [],
    players: {},
    nextSeat: 0,
    endedEarly: false,
  };
}

export const IN_GAME: readonly Phase[] = ["answer", "predict", "reveal", "echo", "echo_reveal"];
const COLLECTING: readonly Phase[] = ["answer", "predict", "echo"];
export const isInGame = (s: RoomState) => IN_GAME.includes(s.phase);

export function playersBySeat(s: RoomState): Player[] {
  return Object.values(s.players).sort((a, b) => a.seat - b.seat);
}

export function activePlayers(s: RoomState): Player[] {
  return playersBySeat(s).filter((p) => p.role === "player");
}

/** Participants who still have a seat in the room. */
function presentParticipants(s: RoomState, r: RoundRecord): Player[] {
  return r.participants.map((id) => s.players[id]).filter((p): p is Player => p !== undefined);
}

function duration(s: RoomState, ms: number): number {
  return Math.max(250, Math.round(ms * s.timerScale));
}

function fail(error: ErrorCode): EngineResult {
  return { ok: false, error };
}

function isHost(s: RoomState, id: string): boolean {
  return s.hostId === id && s.players[id] !== undefined;
}

// ---------------------------------------------------------------------------

export function applyAction(prev: RoomState, action: EngineAction, now: number): EngineResult {
  const s: RoomState = structuredClone(prev);
  // Deadlines that have already passed take effect before anything else, so
  // a submission that arrives after a deadline (but before the alarm fires)
  // is judged against the phase the game has really moved on to.
  if (action.type !== "tick") catchUp(s, now);
  const err = reduce(s, action, now);
  if (err) return fail(err);
  if (action.type !== "tick" && action.type !== "connect" && action.type !== "disconnect") s.lastActivity = now;
  settle(s, now);
  return { ok: true, state: s };
}

function reduce(s: RoomState, a: EngineAction, now: number): ErrorCode | null {
  switch (a.type) {
    case "join":
      return join(s, a.playerId, a.name);
    case "connect": {
      const p = s.players[a.playerId];
      if (!p) return "not_joined";
      p.connected = true;
      p.disconnectedAt = null;
      return null;
    }
    case "disconnect": {
      const p = s.players[a.playerId];
      if (!p) return "not_joined";
      p.connected = false;
      p.disconnectedAt = now;
      return null;
    }
    case "leave":
      if (!s.players[a.playerId]) return "not_joined";
      removePlayer(s, a.playerId);
      return null;
    case "settings":
      if (!s.players[a.playerId]) return "not_joined";
      if (!isHost(s, a.playerId)) return "not_host";
      if (s.phase !== "lobby") return "wrong_phase";
      if (!ROUND_OPTIONS.includes(a.rounds)) return "invalid_value";
      s.settings.rounds = a.rounds;
      return null;
    case "start":
      return start(s, a.playerId, now);
    case "answer":
      return submit(s, a.playerId, "answer", a.value);
    case "predict":
      return submit(s, a.playerId, "predict", a.value);
    case "echo":
      return submitEcho(s, a.playerId, a.choice);
    case "consent": {
      const p = s.players[a.playerId];
      if (!p) return "not_joined";
      // Consent is locked during a game so it always covers every answer in it.
      if (s.phase !== "lobby") return "wrong_phase";
      p.onRecord = a.value;
      return null;
    }
    case "next":
      if (!s.players[a.playerId]) return "not_joined";
      if (!isHost(s, a.playerId)) return "not_host";
      if (s.phase !== "reveal" && s.phase !== "echo_reveal") return "wrong_phase";
      advance(s, now);
      return null;
    case "play_again":
      return playAgain(s, a.playerId);
    case "tick":
      tick(s, now);
      return null;
  }
}

function join(s: RoomState, id: string, rawName: string): ErrorCode | null {
  if (s.players[id]) return "already_joined";
  const name = normalizeName(rawName);
  if (name === null) return "invalid_name";
  const lower = name.toLocaleLowerCase();
  if (Object.values(s.players).some((p) => p.name.toLocaleLowerCase() === lower)) return "name_taken";

  const all = Object.values(s.players);
  const playerCount = all.filter((p) => p.role === "player").length;
  const spectatorCount = all.length - playerCount;
  // Late joiners spectate until the next game; joiners on the final screen
  // are promoted when the host starts a rematch.
  let role: Player["role"];
  if (s.phase === "lobby") {
    if (playerCount >= MAX_PLAYERS) return "room_full";
    role = "player";
  } else {
    if (spectatorCount >= MAX_SPECTATORS) return "room_full";
    role = "spectator";
  }

  const used = new Set(all.map((p) => p.avatar));
  let avatar = 0;
  while (used.has(avatar) && avatar < AVATAR_COUNT - 1) avatar++;

  s.players[id] = {
    id,
    name,
    avatar,
    seat: s.nextSeat++,
    role,
    connected: true,
    disconnectedAt: null,
    score: 0,
    bullseyes: 0,
    wildcards: 0,
    onRecord: false,
  };
  return null;
}

function removePlayer(s: RoomState, id: string): void {
  delete s.players[id];
  const r = s.current;
  if (r && COLLECTING.includes(s.phase)) {
    // Unrevealed submissions from a departed player are discarded so the
    // average reflects only people still in the room.
    r.participants = r.participants.filter((p) => p !== id);
    delete r.answers[id];
    delete r.predictions[id];
    delete r.choices[id];
  }
  if (s.hostId === id) s.hostId = null;
}

function start(s: RoomState, id: string, now: number): ErrorCode | null {
  if (!s.players[id]) return "not_joined";
  if (!isHost(s, id)) return "not_host";
  if (s.phase !== "lobby") return "wrong_phase";
  const ready = activePlayers(s).filter((p) => p.connected);
  if (ready.length < MIN_PLAYERS) return "not_enough_players";

  const rand = mulberry32(mixSeed(s.seed, s.gameNumber));
  s.prompts = shuffle(PROMPTS.map((p) => p.id), rand).slice(0, s.settings.rounds);
  s.history = [];
  s.endedEarly = false;
  for (const p of Object.values(s.players)) {
    p.score = 0;
    p.bullseyes = 0;
    p.wildcards = 0;
  }
  beginRound(s, 1, now);
  return null;
}

function beginRound(s: RoomState, index: number, now: number): void {
  const promptId = s.prompts[index - 1];
  if (promptId === undefined) throw new Error("prompt list exhausted");
  // Generated once and persisted with the round: never regenerated later.
  const echo = index % ECHO_EVERY === 0 ? generateEcho(s, index) : null;
  s.round = index;
  s.current = {
    index,
    kind: echo ? "echo" : "regular",
    promptId,
    participants: activePlayers(s).map((p) => p.id),
    answers: {},
    predictions: {},
    echo,
    choices: {},
    average: null,
    voided: false,
    wildcardId: null,
    scores: {},
  };
  s.phase = echo ? "echo" : "answer";
  s.deadline = now + duration(s, echo ? DURATIONS.echo : DURATIONS.answer);
}

function submit(s: RoomState, id: string, kind: "answer" | "predict", value: number): ErrorCode | null {
  if (!s.players[id]) return "not_joined";
  if (s.phase !== kind) return "wrong_phase";
  const r = s.current;
  if (!r || !r.participants.includes(id)) return "not_participant";
  const bucket = kind === "answer" ? r.answers : r.predictions;
  if (bucket[id] !== undefined) return "already_submitted";
  const valid = kind === "answer" ? isValidAnswer(value) : isValidPrediction(value);
  if (!valid) return "invalid_value";
  bucket[id] = kind === "answer" ? value : Math.round(value * 10) / 10;
  return null;
}

function submitEcho(s: RoomState, id: string, choice: number): ErrorCode | null {
  if (!s.players[id]) return "not_joined";
  if (s.phase !== "echo") return "wrong_phase";
  const r = s.current;
  if (!r?.echo || !r.participants.includes(id)) return "not_participant";
  if (r.choices[id] !== undefined) return "already_submitted";
  if (!isValidEchoChoice(r.echo, id, choice)) return "invalid_value";
  r.choices[id] = choice;
  return null;
}

function revealEcho(s: RoomState, now: number): void {
  const r = s.current;
  if (!r?.echo) return;
  const ids = presentParticipants(s, r).map((p) => p.id);
  r.participants = ids;
  // Never name a Who Said It subject who has left the room.
  const cancelled = r.echo.kind === "who" && !s.players[r.echo.subjectId];
  r.voided = cancelled;
  r.scores = cancelled ? Object.fromEntries(ids.map((id) => [id, { ...ZERO_SCORE }])) : scoreEcho(r.echo, ids, r.choices);
  for (const [id, sc] of Object.entries(r.scores)) {
    const p = s.players[id];
    if (p) p.score += sc.total;
  }
  s.phase = "echo_reveal";
  s.deadline = now + duration(s, DURATIONS.echoReveal);
}

/** Moves the current phase forward exactly one step. */
function advance(s: RoomState, now: number): void {
  const r = s.current;
  switch (s.phase) {
    case "answer": {
      if (!r) return;
      const answered = presentParticipants(s, r).filter((p) => r.answers[p.id] !== undefined).length;
      if (answered < 2) reveal(s, now); // voided round: nothing to predict
      else {
        s.phase = "predict";
        s.deadline = now + duration(s, DURATIONS.predict);
      }
      return;
    }
    case "predict":
      reveal(s, now);
      return;
    case "echo":
      revealEcho(s, now);
      return;
    case "reveal":
    case "echo_reveal":
      if (r) s.history.push(r);
      s.current = null;
      if (s.round < s.settings.rounds) beginRound(s, s.round + 1, now);
      else finish(s);
      return;
    default:
      return;
  }
}

function reveal(s: RoomState, now: number): void {
  const r = s.current;
  if (!r) return;
  const ids = presentParticipants(s, r).map((p) => p.id);
  const outcome = scoreRound(ids, r.answers, r.predictions);
  r.participants = ids;
  r.average = outcome.average;
  r.voided = outcome.voided;
  r.wildcardId = outcome.wildcardId;
  r.scores = outcome.scores;
  for (const [id, sc] of Object.entries(outcome.scores)) {
    const p = s.players[id];
    if (!p) continue;
    p.score += sc.total;
    if (sc.bullseye > 0) p.bullseyes++;
    if (sc.wildcard > 0) p.wildcards++;
  }
  s.phase = "reveal";
  s.deadline = now + duration(s, DURATIONS.reveal);
}

function finish(s: RoomState): void {
  s.phase = "final";
  s.deadline = null;
  s.current = null;
}

function playAgain(s: RoomState, id: string): ErrorCode | null {
  if (!s.players[id]) return "not_joined";
  if (!isHost(s, id)) return "not_host";
  if (s.phase !== "final") return "wrong_phase";
  s.gameNumber++;
  s.phase = "lobby";
  s.round = 0;
  s.deadline = null;
  s.prompts = [];
  s.current = null;
  s.history = [];
  s.endedEarly = false;
  let count = activePlayers(s).length;
  for (const p of playersBySeat(s)) {
    p.score = 0;
    p.bullseyes = 0;
    p.wildcards = 0;
    if (p.role === "spectator" && count < MAX_PLAYERS) {
      p.role = "player";
      count++;
    }
  }
  return null;
}

/** Applies phase deadlines that are due. Bounded: each step moves the deadline forward or clears it. */
function catchUp(s: RoomState, now: number): void {
  for (let i = 0; i < 4 && s.deadline !== null && s.deadline <= now; i++) advance(s, now);
}

/** Time-driven transitions: phase deadlines, grace periods, host migration. */
function tick(s: RoomState, now: number): void {
  catchUp(s, now);

  // Seats are only reclaimed in the lobby, so final standings stay intact.
  if (s.phase === "lobby") {
    for (const p of Object.values(s.players)) {
      if (!p.connected && p.disconnectedAt !== null && now - p.disconnectedAt >= LOBBY_GRACE_MS) removePlayer(s, p.id);
    }
  }
  const host = s.hostId ? s.players[s.hostId] : undefined;
  if (host && !host.connected && host.disconnectedAt !== null && now - host.disconnectedAt >= HOST_GRACE_MS) {
    const next = hostSuccessor(s, host.id);
    if (next) s.hostId = next.id;
  }
}

/** Who would take over from a departed host: the earliest-seated connected player. */
function hostSuccessor(s: RoomState, hostId: string): Player | undefined {
  return playersBySeat(s).find((p) => p.connected && p.id !== hostId && p.role === "player");
}

/** Invariants restored after every action. */
function settle(s: RoomState, now: number): void {
  // Host: keep the current host if present; otherwise the earliest-seated
  // connected player (players before spectators), else anyone at all.
  if (!s.hostId || !s.players[s.hostId]) {
    const seated = playersBySeat(s);
    const pick =
      seated.find((p) => p.connected && p.role === "player") ??
      seated.find((p) => p.connected) ??
      seated.find((p) => p.role === "player") ??
      seated[0];
    s.hostId = pick ? pick.id : null;
  }

  // A game cannot continue with fewer than two seated players.
  if (isInGame(s) && activePlayers(s).length < MIN_PLAYERS) {
    if (s.current && (s.phase === "reveal" || s.phase === "echo_reveal")) s.history.push(s.current);
    s.endedEarly = true;
    finish(s);
  }

  // Early advance once every connected participant has submitted.
  for (let i = 0; i < 3; i++) {
    const r = s.current;
    if (!r || !COLLECTING.includes(s.phase)) break;
    const bucket = s.phase === "answer" ? r.answers : s.phase === "predict" ? r.predictions : r.choices;
    const present = presentParticipants(s, r);
    const connected = present.filter((p) => p.connected);
    const submittedCount = present.filter((p) => bucket[p.id] !== undefined).length;
    const allIn = connected.length > 0 && connected.every((p) => bucket[p.id] !== undefined);
    // Never end a phase early on a single submission while others are merely
    // disconnected: wait for the deadline so they can come back.
    if (!allIn || submittedCount < Math.min(2, present.length)) break;
    advance(s, now);
  }

  const anyoneConnected = Object.values(s.players).some((p) => p.connected);
  if (anyoneConnected) s.emptySince = null;
  else if (s.emptySince === null) s.emptySince = now;
}

// ---------------------------------------------------------------------------
// Scheduling helpers for the Durable Object alarm.

/**
 * Earliest time at which `tick` could change the state, or null. Invariant
 * (tested): right after a tick at time t, this is null or later than t —
 * otherwise the Durable Object would re-arm its alarm in a tight loop.
 */
export function nextWakeTime(s: RoomState): number | null {
  const times: number[] = [];
  if (s.deadline !== null) times.push(s.deadline);
  if (s.phase === "lobby") {
    for (const p of Object.values(s.players)) {
      if (!p.connected && p.disconnectedAt !== null) times.push(p.disconnectedAt + LOBBY_GRACE_MS);
    }
  }
  // Host hand-over only needs a wake-up if someone could take over. Without
  // this check, a room whose players had all left re-armed its alarm every
  // 50 ms until it was deleted (~12,000 writes per abandoned room).
  const host = s.hostId ? s.players[s.hostId] : undefined;
  if (host && !host.connected && host.disconnectedAt !== null && hostSuccessor(s, host.id)) {
    times.push(host.disconnectedAt + HOST_GRACE_MS);
  }
  if (s.emptySince !== null) times.push(s.emptySince + ABANDON_MS);
  return times.length ? Math.min(...times) : null;
}

export function isAbandoned(s: RoomState, now: number): boolean {
  return s.emptySince !== null && now - s.emptySince >= ABANDON_MS;
}

/**
 * Upgrades state persisted by an older version (v1 had no Echo Rounds or
 * consent). Missing fields get safe defaults: regular rounds, no consent.
 */
export function migrateState(raw: unknown): RoomState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Omit<RoomState, "v"> & { v: number };
  if (s.v === 2) return s as RoomState;
  if (s.v !== 1) return null;
  const fixRound = (r: Partial<RoundRecord> & RoundRecord) => {
    r.kind ??= "regular";
    r.echo ??= null;
    r.choices ??= {};
    for (const sc of Object.values(r.scores ?? {})) sc.mystery ??= 0;
  };
  if (s.current) fixRound(s.current);
  s.history.forEach(fixRound);
  for (const p of Object.values(s.players)) p.onRecord ??= false;
  s.v = 2;
  return s as RoomState;
}

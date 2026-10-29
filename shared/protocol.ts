// Wire protocol and authoritative state types.
//
// Client → server: one JSON object per WebSocket text frame (ClientMessage).
// Server → client: ServerMessage. After every accepted change the server
// pushes a fresh personalised `state` snapshot (ClientView) to each socket.
// See docs/PROTOCOL.md for the sequence.

import { ANSWER_MAX, ANSWER_MIN, ECHO_CHOICE_MAX, NAME_MAX, ROUND_OPTIONS, type RoundCount } from "./rules";

/**
 * Bumped whenever the server can send something an older client can't show
 * (a new phase, a new required field). Clients compare it to their own and
 * ask the player to refresh instead of rendering a broken screen.
 */
export const PROTOCOL_VERSION = 2;

// ---------------------------------------------------------------------------
// Authoritative server state (never sent to clients as-is)

export type Phase = "lobby" | "answer" | "predict" | "reveal" | "echo" | "echo_reveal" | "final";
export type Role = "player" | "spectator";

export interface Player {
  id: string;
  name: string;
  avatar: number;
  seat: number;
  role: Role;
  connected: boolean;
  disconnectedAt: number | null;
  score: number;
  bullseyes: number;
  wildcards: number;
  /** Consent for "Who said it?" to name this player. Lobby-only switch, off by default. */
  onRecord: boolean;
}

export interface RoundScore {
  prediction: number | null;
  /** |prediction − average|, full precision. */
  error: number | null;
  base: number;
  bullseye: number;
  wildcard: number;
  /** Who Said It subject's bonus for fooling guessers (0 elsewhere). */
  mystery: number;
  total: number;
}

export type EchoKind = "count" | "pattern" | "who";
export type PatternMetric = "highest" | "lowest" | "split";

/** A generated Echo Round. `truth` (and `subjectId`) are SECRET until the echo reveal. */
export type EchoChallenge =
  | { kind: "count"; sourceRound: number; promptId: string; threshold: number; max: number; truth: number }
  | { kind: "pattern"; metric: PatternMetric; options: { round: number; promptId: string }[]; truth: number }
  | {
      kind: "who";
      sourceRound: number;
      promptId: string;
      value: number;
      subjectId: string;
      /** Player ids, seat order. */
      options: string[];
      truth: number;
    };

export interface RoundRecord {
  index: number;
  kind: "regular" | "echo";
  /** Prompt reserved for this round number (unused by an Echo Round). */
  promptId: string;
  /** Player ids eligible to answer/predict this round (snapshotted at start). */
  participants: string[];
  /** SECRET until reveal, and identities stay secret after reveal. */
  answers: Record<string, number>;
  /** SECRET until reveal. */
  predictions: Record<string, number>;
  /** Echo Rounds only. */
  echo: EchoChallenge | null;
  /** Echo picks. SECRET until the echo reveal. */
  choices: Record<string, number>;
  average: number | null;
  voided: boolean;
  wildcardId: string | null;
  scores: Record<string, RoundScore>;
}

export interface Settings {
  rounds: RoundCount;
}

export interface RoomState {
  v: 2;
  code: string;
  createdAt: number;
  /** Last client-initiated change; used only for diagnostics. */
  lastActivity: number;
  /** Time the last connected socket went away, or null while anyone is connected. */
  emptySince: number | null;
  hostId: string | null;
  settings: Settings;
  /** Multiplier on phase durations (1 in production, smaller in tests). */
  timerScale: number;
  seed: number;
  gameNumber: number;
  phase: Phase;
  deadline: number | null;
  round: number;
  prompts: string[];
  current: RoundRecord | null;
  history: RoundRecord[];
  players: Record<string, Player>;
  nextSeat: number;
  endedEarly: boolean;
}

// ---------------------------------------------------------------------------
// Client → server

export type ClientMessage =
  | { t: "hello"; name: string }
  | { t: "resume"; playerId: string; token: string }
  | { t: "answer"; value: number }
  | { t: "predict"; value: number }
  | { t: "echo"; choice: number }
  | { t: "consent"; value: boolean }
  | { t: "start" }
  | { t: "next" }
  | { t: "settings"; rounds: RoundCount }
  | { t: "play_again" }
  | { t: "leave" }
  | { t: "ping" };

// ---------------------------------------------------------------------------
// Server → client

export type ErrorCode =
  | "bad_message"
  | "not_joined"
  | "already_joined"
  | "invalid_name"
  | "name_taken"
  | "room_full"
  | "bad_token"
  | "not_host"
  | "wrong_phase"
  | "already_submitted"
  | "invalid_value"
  | "not_enough_players"
  | "not_participant"
  | "rate_limited"
  | "room_closed";

export type ServerMessage =
  | { t: "welcome"; playerId: string; token?: string; resumed: boolean; protocol?: number }
  | { t: "state"; view: ClientView }
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "pong" }
  | { t: "bye"; reason: "left" | "replaced" | "room_closed" };

export interface PlayerView {
  id: string;
  name: string;
  avatar: number;
  role: Role;
  connected: boolean;
  isHost: boolean;
  score: number;
  /** Whether this player has submitted in the current phase (null outside answer/predict). */
  submitted: boolean | null;
}

export interface PromptView {
  id: string;
  text: string;
  low: string;
  high: string;
}

export interface PredictionView {
  playerId: string;
  value: number | null;
  score: RoundScore;
}

export interface RevealView {
  voided: boolean;
  average: number | null;
  /** counts[i] = number of anonymous answers equal to i + 1. */
  counts: number[];
  answerCount: number;
  yourAnswer: number | null;
  wildcardId: string | null;
  guesses: PredictionView[];
}

export interface Standing {
  playerId: string;
  rank: number;
  score: number;
  bullseyes: number;
  wildcards: number;
}

export interface RoundSummary {
  index: number;
  prompt: PromptView;
  voided: boolean;
  average: number | null;
  counts: number[];
}

export interface EchoPickView {
  playerId: string;
  choice: number | null;
  score: RoundScore;
}

export interface EchoStatsView {
  average: number;
  spread: number;
  counts: number[];
}

export interface EchoResultView {
  /** Who Said It subject left before the reveal: no points. */
  cancelled: boolean;
  truth: number;
  subjectId: string | null;
  picks: EchoPickView[];
  /** pattern: stats of each option, same order as `promptOptions`. */
  stats: EchoStatsView[] | null;
  /** count: the source round's anonymous distribution. */
  counts: number[] | null;
}

export interface EchoView {
  kind: EchoKind;
  /** True for the game's first Echo Round, so the client can explain the format. */
  first: boolean;
  sourceRound: number | null;
  prompt: PromptView | null;
  threshold: number | null;
  max: number | null;
  value: number | null;
  metric: PatternMetric | null;
  promptOptions: PromptView[] | null;
  playerOptions: string[] | null;
  /** Who Said It: true only in the subject's own view. */
  youAreSubject: boolean;
  result: EchoResultView | null;
}

export interface ClientView {
  code: string;
  phase: Phase;
  round: number;
  totalRounds: number;
  deadline: number | null;
  serverNow: number;
  settings: Settings;
  hostId: string | null;
  you: { id: string; role: Role; isHost: boolean; participant: boolean; onRecord: boolean } | null;
  /** How many players opted in to "Who said it?" — a count, never who. */
  onRecordCount: number;
  players: PlayerView[];
  prompt: PromptView | null;
  submittedCount: number;
  expectedCount: number;
  mine: { answer: number | null; prediction: number | null; echo: number | null };
  reveal: RevealView | null;
  echo: EchoView | null;
  standings: Standing[] | null;
  rounds: RoundSummary[] | null;
  /** End-of-game Room Report (final phase only). Public, shareable data only. */
  report: RoomReport | null;
  endedEarly: boolean;
}

// ---------------------------------------------------------------------------
// Room Report (shared/report.ts). Built only from data every player already
// saw during the game: averages, anonymous counts, revealed predictions and
// points, Echo results, and a consented + revealed Who Said It subject.

export type AwardId = "mind_reader" | "bullseye_king" | "wildcard" | "echo_master" | "poker_face";

export interface Award {
  id: AwardId;
  /** Seat order; several on an exact tie. */
  winners: string[];
  /** The number behind the award (e.g. average error, count). */
  value: number;
}

export interface PlayerStats {
  playerId: string;
  /** Mean |prediction − average| over counted regular rounds the player predicted in. */
  avgError: number | null;
  /** How many counted regular rounds the player predicted in. */
  predicted: number;
  bullseyes: number;
  wildcards: number;
  echoPlayed: number;
  /** Echo picks that were exactly right. */
  echoCorrect: number;
  /** Points from Echo picks (excludes the Who Said It subject bonus). */
  echoPoints: number;
}

export interface RegularRoundReport {
  kind: "regular";
  index: number;
  prompt: PromptView;
  voided: boolean;
  average: number | null;
  spread: number | null;
  counts: number[];
  answerCount: number;
  /** Closest predictor(s) and their error; null if nobody predicted. */
  closest: { playerIds: string[]; error: number } | null;
  bullseyes: number;
}

export interface EchoRoundReport {
  kind: "echo";
  index: number;
  mode: EchoKind;
  cancelled: boolean;
  sourceRound: number | null;
  prompt: PromptView | null;
  threshold: number | null;
  value: number | null;
  metric: PatternMetric | null;
  promptOptions: PromptView[] | null;
  truth: number;
  /** Who Said It subject — only when consented and actually revealed. */
  revealedSubject: string | null;
  /** Guessers (excludes the Who Said It subject). */
  guessers: number;
  correct: number;
}

export type RoundReport = RegularRoundReport | EchoRoundReport;

export type Moment =
  | { kind: "closest_call"; round: number; playerIds: string[]; error: number; average: number }
  | { kind: "most_divided"; round: number; prompt: PromptView; spread: number }
  | { kind: "most_agreed"; round: number; prompt: PromptView; spread: number }
  | { kind: "best_echo"; round: number; mode: EchoKind; correct: number; guessers: number };

export interface RoomReport {
  code: string;
  playedRounds: number;
  totalRounds: number;
  endedEarly: boolean;
  awards: Award[];
  moments: Moment[];
  players: PlayerStats[];
  rounds: RoundReport[];
}

// ---------------------------------------------------------------------------
// Validation

export const MAX_MESSAGE_BYTES = 1024;

const ID_RE = /^[0-9a-f-]{36}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Trims, collapses whitespace and strips control characters. Returns null if invalid. */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length < 1 || [...name].length > NAME_MAX) return null;
  return name;
}

export function isValidAnswer(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= ANSWER_MIN && v <= ANSWER_MAX;
}

/** Predictions are tenths between 1.0 and 10.0. */
export function isValidPrediction(v: unknown): v is number {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  if (v < ANSWER_MIN || v > ANSWER_MAX) return false;
  return Math.abs(v * 10 - Math.round(v * 10)) < 1e-6;
}

export type ParseResult = { ok: true; msg: ClientMessage } | { ok: false; error: string };

/** Parses and strictly validates one client frame. Unknown fields are rejected. */
export function parseClientMessage(raw: unknown): ParseResult {
  if (typeof raw !== "string") return { ok: false, error: "Expected a text frame" };
  if (raw.length > MAX_MESSAGE_BYTES) return { ok: false, error: "Message too large" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  if (!isObject(data) || typeof data.t !== "string") return { ok: false, error: "Missing type" };
  const keys = Object.keys(data);
  const only = (...allowed: string[]) => keys.every((k) => k === "t" || allowed.includes(k));

  switch (data.t) {
    case "hello": {
      if (!only("name")) break;
      const name = normalizeName(data.name);
      if (name === null) return { ok: false, error: "Invalid name" };
      return { ok: true, msg: { t: "hello", name } };
    }
    case "resume":
      if (!only("playerId", "token")) break;
      if (typeof data.playerId !== "string" || !ID_RE.test(data.playerId)) break;
      if (typeof data.token !== "string" || !TOKEN_RE.test(data.token)) break;
      return { ok: true, msg: { t: "resume", playerId: data.playerId, token: data.token } };
    case "answer":
      if (!only("value") || !isValidAnswer(data.value)) return { ok: false, error: "Answer must be a whole number from 1 to 10" };
      return { ok: true, msg: { t: "answer", value: data.value } };
    case "predict":
      if (!only("value") || !isValidPrediction(data.value)) return { ok: false, error: "Prediction must be between 1.0 and 10.0" };
      return { ok: true, msg: { t: "predict", value: Math.round(data.value * 10) / 10 } };
    case "echo":
      if (!only("choice")) break;
      if (typeof data.choice !== "number" || !Number.isInteger(data.choice) || data.choice < 0 || data.choice > ECHO_CHOICE_MAX)
        return { ok: false, error: "Invalid choice" };
      return { ok: true, msg: { t: "echo", choice: data.choice } };
    case "consent":
      if (!only("value") || typeof data.value !== "boolean") break;
      return { ok: true, msg: { t: "consent", value: data.value } };
    case "settings":
      if (!only("rounds")) break;
      if (!ROUND_OPTIONS.includes(data.rounds as RoundCount)) return { ok: false, error: "Unsupported round count" };
      return { ok: true, msg: { t: "settings", rounds: data.rounds as RoundCount } };
    case "start":
    case "next":
    case "play_again":
    case "leave":
    case "ping":
      if (!only()) break;
      return { ok: true, msg: { t: data.t } };
  }
  return { ok: false, error: "Malformed message" };
}

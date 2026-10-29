// Game constants. Every rule the server enforces lives here so tests, server
// and UI agree on a single source of truth. See docs/RULES.md.

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const MAX_SPECTATORS = 8;

export const ROUND_OPTIONS = [6, 9, 12] as const;
export type RoundCount = (typeof ROUND_OPTIONS)[number];
export const DEFAULT_ROUNDS: RoundCount = 9;

export const ANSWER_MIN = 1;
export const ANSWER_MAX = 10;

/** Base phase durations in ms. Multiplied by the room's timer scale. */
export const DURATIONS = {
  answer: 20_000,
  predict: 20_000,
  reveal: 12_000,
} as const;

/** Disconnected players are removed from the lobby / final screen after this. */
export const LOBBY_GRACE_MS = 60_000;
/** A disconnected host hands the crown to the next connected player after this. */
export const HOST_GRACE_MS = 20_000;
/** A room with nobody connected for this long is deleted. */
export const ABANDON_MS = 10 * 60_000;

export const NAME_MAX = 16;

// Scoring
export const PREDICTION_MAX = 100;
/** Prediction points fall to zero at this distance from the average. */
export const PREDICTION_FALLOFF = 3;
export const BULLSEYE_RANGE = 0.3;
export const BULLSEYE_BONUS = 50;
export const WILDCARD_MIN_DISTANCE = 2;
export const WILDCARD_BONUS = 25;
/** Tolerance for floating-point comparisons on thresholds and ties. */
export const EPSILON = 1e-9;

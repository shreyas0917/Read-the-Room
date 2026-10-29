// Regular-round scoring. Pure functions; all inputs are full precision and
// awarded points are rounded to whole numbers once per component.
//
//  • Target: the mean of every valid answer submitted this round, including
//    the predictor's own answer.
//  • Prediction points: round(100 × max(0, 1 − |prediction − mean| / 3)).
//  • Bullseye: +50 when |prediction − mean| ≤ 0.3.
//  • Wildcard: +25 to the single answer furthest from the mean, if that
//    distance is ≥ 2. Ties for furthest → no wildcard.
//  • A round needs at least two answers to count; otherwise it is voided.
//  • A participant who doesn't predict scores 0 for the round.

import {
  BULLSEYE_BONUS,
  BULLSEYE_RANGE,
  ECHO_CORRECT,
  ECHO_EXACT,
  ECHO_NEAR,
  EPSILON,
  PREDICTION_FALLOFF,
  PREDICTION_MAX,
  WILDCARD_BONUS,
  WILDCARD_MIN_DISTANCE,
  WHO_FOOLED_BONUS,
  WHO_FOOLED_MAX,
} from "./rules";
import type { EchoChallenge, Player, RoundScore, Standing } from "./protocol";

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population standard deviation ("how split was the room"). */
export function stdDev(values: readonly number[]): number | null {
  const m = mean(values);
  if (m === null) return null;
  let sq = 0;
  for (const v of values) sq += (v - m) ** 2;
  return Math.sqrt(sq / values.length);
}

export function predictionPoints(prediction: number, average: number): number {
  const error = Math.abs(prediction - average);
  return Math.round(PREDICTION_MAX * Math.max(0, 1 - error / PREDICTION_FALLOFF));
}

export function isBullseye(prediction: number, average: number): boolean {
  return Math.abs(prediction - average) <= BULLSEYE_RANGE + EPSILON;
}

/** Returns the id of the unique most-extreme answer at least 2 from the mean, else null. */
export function findWildcard(answers: Readonly<Record<string, number>>, average: number): string | null {
  let best: string | null = null;
  let bestDistance = -1;
  let tied = false;
  for (const [id, value] of Object.entries(answers)) {
    const d = Math.abs(value - average);
    if (d > bestDistance + EPSILON) {
      best = id;
      bestDistance = d;
      tied = false;
    } else if (Math.abs(d - bestDistance) <= EPSILON) {
      tied = true;
    }
  }
  if (best === null || tied || bestDistance < WILDCARD_MIN_DISTANCE - EPSILON) return null;
  return best;
}

export interface RoundOutcome {
  average: number | null;
  voided: boolean;
  wildcardId: string | null;
  scores: Record<string, RoundScore>;
}

export const ZERO_SCORE: RoundScore = { prediction: null, error: null, base: 0, bullseye: 0, wildcard: 0, mystery: 0, total: 0 };
const ZERO = ZERO_SCORE;

export function scoreRound(
  participants: readonly string[],
  answers: Readonly<Record<string, number>>,
  predictions: Readonly<Record<string, number>>,
): RoundOutcome {
  const validAnswers: Record<string, number> = {};
  for (const id of participants) {
    const a = answers[id];
    if (a !== undefined) validAnswers[id] = a;
  }
  const average = mean(Object.values(validAnswers));
  const scores: Record<string, RoundScore> = {};

  if (average === null || Object.keys(validAnswers).length < 2) {
    for (const id of participants) scores[id] = { ...ZERO, prediction: predictions[id] ?? null };
    return { average, voided: true, wildcardId: null, scores };
  }

  const wildcardId = findWildcard(validAnswers, average);
  for (const id of participants) {
    const p = predictions[id];
    const wildcard = id === wildcardId ? WILDCARD_BONUS : 0;
    if (p === undefined) {
      scores[id] = { ...ZERO, wildcard, total: wildcard };
      continue;
    }
    const base = predictionPoints(p, average);
    const bullseye = isBullseye(p, average) ? BULLSEYE_BONUS : 0;
    scores[id] = {
      prediction: p,
      error: Math.abs(p - average),
      base,
      bullseye,
      wildcard,
      mystery: 0,
      total: base + bullseye + wildcard,
    };
  }
  return { average, voided: false, wildcardId, scores };
}

/**
 * Echo Round scoring (docs/ECHO_ROUNDS.md). Participants who didn't pick
 * score 0. Who Said It: guessers get 100 for the right person; the subject
 * makes a decoy pick and earns +25 per wrong guess (max 100).
 */
export function scoreEcho(
  ch: EchoChallenge,
  participants: readonly string[],
  choices: Readonly<Record<string, number>>,
): Record<string, RoundScore> {
  const scores: Record<string, RoundScore> = {};
  const subject = ch.kind === "who" ? ch.subjectId : null;
  const fooled = participants.filter((id) => id !== subject && choices[id] !== undefined && choices[id] !== ch.truth).length;
  for (const id of participants) {
    const c = choices[id];
    let base = 0;
    let mystery = 0;
    if (id === subject) mystery = Math.min(WHO_FOOLED_MAX, WHO_FOOLED_BONUS * fooled);
    else if (c !== undefined) {
      if (ch.kind === "count") {
        const diff = Math.abs(c - ch.truth);
        base = diff === 0 ? ECHO_EXACT : diff === 1 ? ECHO_NEAR : 0;
      } else base = c === ch.truth ? ECHO_CORRECT : 0;
    }
    scores[id] = { ...ZERO, base, mystery, total: base + mystery };
  }
  return scores;
}

/**
 * Final ranking: score desc, then bullseyes desc. Players equal on both share
 * a rank (standard competition ranking: 1, 1, 3). Seat order breaks display ties.
 */
export function rankPlayers(players: readonly Player[]): Standing[] {
  const sorted = players
    .slice()
    .sort((a, b) => b.score - a.score || b.bullseyes - a.bullseyes || a.seat - b.seat);
  const out: Standing[] = [];
  sorted.forEach((p, i) => {
    const prev = sorted[i - 1];
    const prevStanding = out[i - 1];
    const rank =
      prev && prevStanding && prev.score === p.score && prev.bullseyes === p.bullseyes ? prevStanding.rank : i + 1;
    out.push({ playerId: p.id, rank, score: p.score, bullseyes: p.bullseyes, wildcards: p.wildcards });
  });
  return out;
}

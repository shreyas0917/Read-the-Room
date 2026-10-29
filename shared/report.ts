// End-of-game Room Report: awards, highlights, per-player stats and a
// round-by-round recap. Pure and deterministic.
//
// Privacy rule for this file: use ONLY data every player already saw during
// the game — averages, spreads and anonymous counts of answers, revealed
// predictions and points, Echo results, and a Who Said It subject who opted
// in and was named at the reveal. Never derive anything from an individual's
// hidden answer (so there is deliberately no "most average answerer" award).

import type {
  Award,
  EchoRoundReport,
  Moment,
  PlayerStats,
  PromptView,
  RegularRoundReport,
  RoomReport,
  RoomState,
  RoundRecord,
} from "./protocol";
import { answersOf } from "./echo";
import { playersBySeat } from "./engine";
import { getPrompt } from "./prompts";
import { ANSWER_MAX, EPSILON, MIND_READER_MIN_PREDICTIONS } from "./rules";
import { mean, stdDev } from "./scoring";

function promptView(id: string): PromptView {
  const p = getPrompt(id);
  return { id: p.id, text: p.text, low: p.low, high: p.high };
}

function countsOf(r: RoundRecord): number[] {
  const counts = new Array<number>(ANSWER_MAX).fill(0);
  for (const v of answersOf(r)) counts[v - 1] = (counts[v - 1] ?? 0) + 1;
  return counts;
}

/** Ids whose value equals the best (within EPSILON), in the given (seat) order. */
function bestOf<T extends { playerId: string }>(
  items: readonly T[],
  value: (t: T) => number | null,
  dir: "max" | "min",
): { winners: string[]; value: number } | null {
  const scored = items.map((t) => ({ id: t.playerId, v: value(t) })).filter((x): x is { id: string; v: number } => x.v !== null);
  if (scored.length === 0) return null;
  const target = dir === "max" ? Math.max(...scored.map((x) => x.v)) : Math.min(...scored.map((x) => x.v));
  return { winners: scored.filter((x) => Math.abs(x.v - target) <= EPSILON).map((x) => x.id), value: target };
}

export function buildReport(s: RoomState): RoomReport {
  const seated = playersBySeat(s).filter((p) => p.role === "player");
  const seat = new Map(seated.map((p) => [p.id, p.seat]));
  const inSeatOrder = (ids: Iterable<string>) => [...ids].filter((id) => seat.has(id)).sort((a, b) => seat.get(a)! - seat.get(b)!);

  const regular = s.history.filter((r) => r.kind === "regular");
  const counted = regular.filter((r) => !r.voided);
  const echoes = s.history.filter((r) => r.kind === "echo" && r.echo);
  const subjectOf = (r: RoundRecord) => (r.echo?.kind === "who" ? r.echo.subjectId : null);
  const guessersOf = (r: RoundRecord) => r.participants.filter((id) => id !== subjectOf(r));

  // --- Per-player stats ----------------------------------------------------------
  const fooled = new Map<string, number>();
  for (const r of echoes) {
    const subject = subjectOf(r);
    if (!subject || r.voided || !r.echo) continue;
    const n = guessersOf(r).filter((id) => r.choices[id] !== undefined && r.choices[id] !== r.echo!.truth).length;
    fooled.set(subject, (fooled.get(subject) ?? 0) + n);
  }

  const players: PlayerStats[] = seated.map((p) => {
    const errors = counted.map((r) => r.scores[p.id]?.error).filter((e): e is number => typeof e === "number");
    let echoPlayed = 0;
    let echoCorrect = 0;
    let echoPoints = 0;
    for (const r of echoes) {
      if (r.voided || !r.echo || !r.participants.includes(p.id) || subjectOf(r) === p.id) continue;
      echoPlayed++;
      echoPoints += r.scores[p.id]?.base ?? 0;
      if (r.choices[p.id] === r.echo.truth) echoCorrect++;
    }
    return {
      playerId: p.id,
      avgError: errors.length ? (mean(errors) ?? null) : null,
      predicted: errors.length,
      bullseyes: p.bullseyes,
      wildcards: p.wildcards,
      echoPlayed,
      echoCorrect,
      echoPoints,
    };
  });

  // --- Awards (fixed order; exact ties share; meaningless awards are skipped) ----
  const awards: Award[] = [];
  const give = (id: Award["id"], res: { winners: string[]; value: number } | null) => {
    if (!res || res.winners.length === 0) return;
    // An award everybody shares says nothing about anybody.
    if (seated.length > 1 && res.winners.length === seated.length) return;
    awards.push({ id, winners: res.winners, value: res.value });
  };
  // Mind Reader needs real participation, so one lucky guess can't win it.
  const minPredictions = Math.max(MIND_READER_MIN_PREDICTIONS, Math.ceil(counted.length / 2));
  if (counted.length >= MIND_READER_MIN_PREDICTIONS) {
    give("mind_reader", bestOf(players, (p) => (p.predicted >= minPredictions ? p.avgError : null), "min"));
  }
  give("bullseye_king", bestOf(players, (p) => (p.bullseyes > 0 ? p.bullseyes : null), "max"));
  give("wildcard", bestOf(players, (p) => (p.wildcards > 0 ? p.wildcards : null), "max"));
  give("echo_master", bestOf(players, (p) => (p.echoPoints > 0 ? p.echoPoints : null), "max"));
  give(
    "poker_face",
    bestOf(
      players.map((p) => ({ playerId: p.playerId, n: fooled.get(p.playerId) ?? 0 })),
      (p) => (p.n > 0 ? p.n : null),
      "max",
    ),
  );

  // --- Round by round ------------------------------------------------------------
  const rounds = s.history.map((r): RegularRoundReport | EchoRoundReport => {
    if (r.kind === "echo" && r.echo) {
      const ch = r.echo;
      const guessers = guessersOf(r);
      return {
        kind: "echo",
        index: r.index,
        mode: ch.kind,
        cancelled: r.voided,
        sourceRound: ch.kind === "pattern" ? null : ch.sourceRound,
        prompt: ch.kind === "pattern" ? null : promptView(ch.promptId),
        threshold: ch.kind === "count" ? ch.threshold : null,
        value: ch.kind === "who" ? ch.value : null,
        metric: ch.kind === "pattern" ? ch.metric : null,
        promptOptions: ch.kind === "pattern" ? ch.options.map((o) => promptView(o.promptId)) : null,
        truth: ch.truth,
        // Named only if they consented (enforced at generation) and were revealed.
        revealedSubject: ch.kind === "who" && !r.voided && seat.has(ch.subjectId) ? ch.subjectId : null,
        guessers: guessers.length,
        correct: r.voided ? 0 : guessers.filter((id) => r.choices[id] === ch.truth).length,
      };
    }
    const vals = answersOf(r);
    const errs = r.participants
      .map((id) => ({ id, e: r.scores[id]?.error }))
      .filter((x): x is { id: string; e: number } => typeof x.e === "number" && seat.has(x.id));
    const minErr = errs.length && !r.voided ? Math.min(...errs.map((x) => x.e)) : null;
    return {
      kind: "regular",
      index: r.index,
      prompt: promptView(r.promptId),
      voided: r.voided,
      average: r.voided ? null : r.average,
      spread: r.voided ? null : (stdDev(vals) ?? null),
      counts: r.voided ? new Array<number>(ANSWER_MAX).fill(0) : countsOf(r),
      answerCount: vals.length,
      closest:
        minErr === null
          ? null
          : { playerIds: inSeatOrder(errs.filter((x) => Math.abs(x.e - minErr) <= EPSILON).map((x) => x.id)), error: minErr },
      bullseyes: r.voided ? 0 : r.participants.filter((id) => (r.scores[id]?.bullseye ?? 0) > 0).length,
    };
  });

  // --- Highlights (earliest round wins ties) ----------------------------------------
  const moments: Moment[] = [];
  const regs = rounds.filter((r): r is RegularRoundReport => r.kind === "regular" && !r.voided);
  const call = regs
    .filter((r) => r.closest && r.closest.playerIds.length > 0 && r.average !== null)
    .reduce<RegularRoundReport | null>((best, r) => (!best || r.closest!.error < best.closest!.error - EPSILON ? r : best), null);
  if (call?.closest && call.average !== null) {
    moments.push({ kind: "closest_call", round: call.index, playerIds: call.closest.playerIds, error: call.closest.error, average: call.average });
  }
  if (regs.length >= 2) {
    const bySpread = regs.filter((r) => r.spread !== null);
    const divided = bySpread.reduce((a, b) => (b.spread! > a.spread! + EPSILON ? b : a));
    const agreed = bySpread.reduce((a, b) => (b.spread! < a.spread! - EPSILON ? b : a));
    if (divided.spread! - agreed.spread! > EPSILON) {
      moments.push({ kind: "most_divided", round: divided.index, prompt: divided.prompt, spread: divided.spread! });
      moments.push({ kind: "most_agreed", round: agreed.index, prompt: agreed.prompt, spread: agreed.spread! });
    }
  }
  const echoReps = rounds.filter((r): r is EchoRoundReport => r.kind === "echo" && !r.cancelled && r.guessers > 0 && r.correct > 0);
  if (echoReps.length) {
    const best = echoReps.reduce((a, b) => (b.correct / b.guessers > a.correct / a.guessers + EPSILON ? b : a));
    moments.push({ kind: "best_echo", round: best.index, mode: best.mode, correct: best.correct, guessers: best.guessers });
  }

  return {
    code: s.code,
    playedRounds: s.history.length,
    totalRounds: s.settings.rounds,
    endedEarly: s.endedEarly,
    awards,
    moments,
    players,
    rounds,
  };
}

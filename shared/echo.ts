// Echo Round generation (docs/ECHO_ROUNDS.md). Pure and deterministic: the
// result depends only on persisted state (history, players, seed, game
// number) and the round number. The engine calls this once per Echo Round
// and stores the result, so reconnects and restarts never change a question.

import type { EchoChallenge, EchoKind, PatternMetric, RoomState, RoundRecord } from "./protocol";
import { mixSeed, mulberry32, shuffle } from "./rng";
import { EPSILON, PATTERN_MARGIN, WHO_MIN_ANSWERS } from "./rules";
import { mean, stdDev } from "./scoring";

type Rand = () => number;

const pickOne = <T>(items: readonly T[], rand: Rand): T => items[Math.floor(rand() * items.length)] as T;

/** Answers from a round's final participants, in participant order. */
export function answersOf(r: RoundRecord): number[] {
  const out: number[] = [];
  for (const id of r.participants) {
    const v = r.answers[id];
    if (v !== undefined) out.push(v);
  }
  return out;
}

/** Earlier regular rounds that counted (≥ 2 answers, not voided). */
export function eligibleSources(s: RoomState): RoundRecord[] {
  return s.history.filter((r) => r.kind === "regular" && !r.voided && answersOf(r).length >= 2);
}

// --- Higher or Lower ---------------------------------------------------------

function genCount(s: RoomState, rand: Rand): EchoChallenge | null {
  const sources = eligibleSources(s).filter((r) => new Set(answersOf(r)).size >= 2);
  if (sources.length === 0) return null;
  const r = pickOne(sources, rand);
  const vals = answersOf(r);
  const above = (t: number) => vals.filter((v) => v > t).length;
  // With ≥ 2 distinct values, t = min(vals) always gives 0 < count < n.
  const thresholds = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((t) => above(t) > 0 && above(t) < vals.length);
  const threshold = pickOne(thresholds, rand);
  return { kind: "count", sourceRound: r.index, promptId: r.promptId, threshold, max: vals.length, truth: above(threshold) };
}

// --- Room Pattern ------------------------------------------------------------------

export function patternValue(r: RoundRecord, metric: PatternMetric): number {
  const vals = answersOf(r);
  if (metric === "split") return stdDev(vals) ?? 0;
  const m = mean(vals) ?? 0;
  return metric === "highest" ? m : -m;
}

function genPattern(s: RoomState, rand: Rand): EchoChallenge | null {
  const sources = eligibleSources(s);
  if (sources.length < 3) return null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const trio = shuffle(sources, rand).slice(0, 3);
    for (const metric of shuffle<PatternMetric>(["highest", "lowest", "split"], rand)) {
      const values = trio.map((r) => patternValue(r, metric));
      const best = Math.max(...values);
      const runnerUp = Math.max(...values.filter((_, i) => i !== values.indexOf(best)));
      if (best - runnerUp >= PATTERN_MARGIN - EPSILON) {
        return {
          kind: "pattern",
          metric,
          options: trio.map((r) => ({ round: r.index, promptId: r.promptId })),
          truth: values.indexOf(best),
        };
      }
    }
  }
  return null;
}

// --- Who Said It (opt-in) ----------------------------------------------------------

function genWho(s: RoomState, rand: Rand): EchoChallenge | null {
  const usedSubjects = new Set(
    s.history.flatMap((r) => (r.echo?.kind === "who" ? [r.echo.subjectId] : [])),
  );
  const seated = (id: string) => s.players[id]?.role === "player";

  interface Candidate {
    r: RoundRecord;
    id: string;
    value: number;
    distance: number;
    options: string[];
  }
  const byRound = new Map<number, Candidate[]>();
  for (const r of eligibleSources(s)) {
    const vals = answersOf(r);
    if (vals.length < WHO_MIN_ANSWERS) continue;
    const options = r.participants
      .filter((id) => r.answers[id] !== undefined && seated(id))
      .sort((a, b) => (s.players[a]?.seat ?? 0) - (s.players[b]?.seat ?? 0));
    if (options.length < WHO_MIN_ANSWERS) continue;
    const avg = mean(vals) ?? 0;
    for (const id of options) {
      const p = s.players[id];
      const value = r.answers[id];
      if (!p || value === undefined || !p.onRecord || usedSubjects.has(id) || id === r.wildcardId) continue;
      if (vals.filter((v) => v === value).length !== 1) continue; // must be unique in its round
      const list = byRound.get(r.index) ?? [];
      list.push({ r, id, value, distance: Math.abs(value - avg), options });
      byRound.set(r.index, list);
    }
  }
  if (byRound.size === 0) return null;
  const roundIdx = pickOne([...byRound.keys()].sort((a, b) => a - b), rand);
  // Most extreme unique answer in that round; seat order breaks ties.
  const c = (byRound.get(roundIdx) ?? []).sort((a, b) => b.distance - a.distance || a.options.indexOf(a.id) - b.options.indexOf(b.id))[0];
  if (!c) return null;
  return {
    kind: "who",
    sourceRound: c.r.index,
    promptId: c.r.promptId,
    value: c.value,
    subjectId: c.id,
    options: c.options,
    truth: c.options.indexOf(c.id),
  };
}

// --- Selection ---------------------------------------------------------------------

const ORDER: readonly EchoKind[] = ["count", "pattern", "who"];

export function echoSeed(s: RoomState, round: number): number {
  return mixSeed(mixSeed(s.seed, s.gameNumber), round);
}

/**
 * The Echo Round for `round`, or null if no mode is eligible (the engine then
 * plays a regular round). Prefers a mode not yet used this game.
 */
export function generateEcho(s: RoomState, round: number): EchoChallenge | null {
  const base = echoSeed(s, round);
  const candidates = echoCandidates(s, round);
  if (candidates.length === 0) return null;
  const used = new Set(s.history.flatMap((r) => (r.echo ? [r.echo.kind] : [])));
  const fresh = candidates.filter((c) => !used.has(c.kind));
  return pickOne(fresh.length ? fresh : candidates, mulberry32(base));
}

/** Every eligible challenge for `round`, one per mode, in a fixed order. */
export function echoCandidates(s: RoomState, round: number): EchoChallenge[] {
  const base = echoSeed(s, round);
  const gens = { count: genCount, pattern: genPattern, who: genWho };
  return ORDER.map((k, i) => gens[k](s, mulberry32(mixSeed(base, i + 1)))).filter((c): c is EchoChallenge => c !== null);
}

/** Whether `choice` is a legal pick for `playerId` in this challenge. */
export function isValidEchoChoice(ch: EchoChallenge, playerId: string, choice: number): boolean {
  if (!Number.isInteger(choice) || choice < 0) return false;
  switch (ch.kind) {
    case "count":
      return choice <= ch.max;
    case "pattern":
      return choice < ch.options.length;
    case "who":
      return choice < ch.options.length && ch.options[choice] !== playerId;
  }
}

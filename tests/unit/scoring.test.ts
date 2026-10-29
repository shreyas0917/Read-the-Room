import { describe, expect, it } from "vitest";
import { findWildcard, isBullseye, mean, predictionPoints, rankPlayers, scoreRound } from "../../shared/scoring";
import type { Player } from "../../shared/protocol";

describe("predictionPoints", () => {
  it("is 100 for an exact guess and falls linearly to 0 at distance 3", () => {
    expect(predictionPoints(5, 5)).toBe(100);
    expect(predictionPoints(6.5, 5)).toBe(50);
    expect(predictionPoints(8, 5)).toBe(0);
    expect(predictionPoints(10, 1)).toBe(0);
  });
  it("uses full-precision averages and rounds only the awarded points", () => {
    // mean of 1, 2, 2 = 1.666…; guess 2 → error 0.333… → 88.88… → 89
    expect(predictionPoints(2, mean([1, 2, 2])!)).toBe(89);
  });
});

describe("isBullseye", () => {
  it("includes the 0.3 boundary despite floating-point error", () => {
    expect(isBullseye(5.3, 5)).toBe(true);
    expect(isBullseye(4.7, 5)).toBe(true);
    expect(isBullseye(5.31, 5)).toBe(false);
    // 0.1 + 0.2 style drift: average 6.666…, guess 6.4 → 0.2666 ≤ 0.3
    expect(isBullseye(6.4, 20 / 3)).toBe(true);
  });
});

describe("findWildcard", () => {
  it("awards the unique furthest answer at distance ≥ 2", () => {
    const answers = { a: 5, b: 5, c: 5, d: 10 }; // mean 6.25, d is 3.75 away
    expect(findWildcard(answers, mean(Object.values(answers))!)).toBe("d");
  });
  it("awards nobody on a tie for furthest", () => {
    const answers = { a: 1, b: 10, c: 5, d: 6 }; // mean 5.5, a and b both 4.5 away
    expect(findWildcard(answers, 5.5)).toBeNull();
  });
  it("awards nobody when the furthest answer is under 2 away", () => {
    expect(findWildcard({ a: 5, b: 6, c: 7 }, 6)).toBeNull();
  });
  it("never awards a wildcard with two answers (always tied)", () => {
    expect(findWildcard({ a: 1, b: 10 }, 5.5)).toBeNull();
  });
});

describe("scoreRound", () => {
  it("averages every valid answer including the predictor's own", () => {
    const out = scoreRound(["a", "b", "c"], { a: 2, b: 4, c: 9 }, { a: 5, b: 3, c: 8 });
    expect(out.average).toBeCloseTo(5);
    expect(out.voided).toBe(false);
    expect(out.scores.a).toMatchObject({ base: 100, bullseye: 50, total: 150 });
    expect(out.scores.b?.base).toBe(33); // error 2 → 33.33 → 33
    expect(out.scores.c?.base).toBe(0);
  });
  it("gives 0 to a participant who did not predict but still pays their wildcard", () => {
    const out = scoreRound(["a", "b", "c", "d"], { a: 5, b: 5, c: 5, d: 10 }, { a: 6 });
    expect(out.wildcardId).toBe("d");
    expect(out.scores.d).toMatchObject({ prediction: null, base: 0, wildcard: 25, total: 25 });
    expect(out.scores.b?.total).toBe(0);
  });
  it("ignores answers from non-participants", () => {
    const out = scoreRound(["a", "b"], { a: 2, b: 4, x: 10 }, {});
    expect(out.average).toBe(3);
  });
  it("voids the round with fewer than two answers", () => {
    const out = scoreRound(["a", "b", "c"], { a: 7 }, { a: 7, b: 7 });
    expect(out.voided).toBe(true);
    expect(Object.values(out.scores).every((s) => s.total === 0)).toBe(true);
  });
});

describe("rankPlayers", () => {
  const P = (id: string, seat: number, score: number, bullseyes = 0): Player => ({
    id, name: id, avatar: 0, seat, role: "player", connected: true, disconnectedAt: null, score, bullseyes, wildcards: 0,
  });
  it("breaks score ties by bullseyes, then shares rank", () => {
    const r = rankPlayers([P("a", 0, 300, 1), P("b", 1, 300, 2), P("c", 2, 300, 1), P("d", 3, 100)]);
    expect(r.map((s) => [s.playerId, s.rank])).toEqual([["b", 1], ["a", 2], ["c", 2], ["d", 4]]);
  });
});

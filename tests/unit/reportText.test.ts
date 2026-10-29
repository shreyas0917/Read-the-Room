import { describe, expect, it } from "vitest";
import type { PlayerView, RoomReport, Standing } from "../../shared/protocol";
import { echoAnswer, joinNames, momentText, reportText } from "../../src/lib/reportText";

const P = (id: string, name: string): PlayerView => ({
  id, name, avatar: 0, role: "player", connected: true, isHost: false, score: 0, submitted: null,
});
const players = [P("a", "Ana"), P("b", "Ben"), P("c", "Cy")];
const prompt = { id: "p01", text: "Rate pineapple on pizza.", low: "Illegal", high: "Perfection" };
const standings: Standing[] = [
  { playerId: "a", rank: 1, score: 500, bullseyes: 2, wildcards: 0 },
  { playerId: "b", rank: 2, score: 300, bullseyes: 0, wildcards: 1 },
  { playerId: "c", rank: 3, score: 100, bullseyes: 0, wildcards: 0 },
];

const report: RoomReport = {
  code: "ABCD",
  playedRounds: 3,
  totalRounds: 6,
  endedEarly: true,
  awards: [{ id: "bullseye_king", winners: ["a"], value: 2 }],
  moments: [{ kind: "closest_call", round: 1, playerIds: ["a", "b"], error: 0, average: 6 }],
  players: [],
  rounds: [
    { kind: "regular", index: 1, prompt, voided: false, average: 6, spread: 1, counts: [], answerCount: 3, closest: { playerIds: ["a"], error: 0 }, bullseyes: 1 },
    { kind: "regular", index: 2, prompt, voided: true, average: null, spread: null, counts: [], answerCount: 1, closest: null, bullseyes: 0 },
    { kind: "echo", index: 3, mode: "who", cancelled: false, sourceRound: 1, prompt, threshold: null, value: 9, metric: null, promptOptions: null, truth: 1, revealedSubject: "b", guessers: 2, correct: 1 },
  ],
};

describe("reportText", () => {
  it("summarises winner, standings, awards, highlights and every round", () => {
    const t = reportText(report, standings, players, "https://example.test");
    expect(t).toContain("READ THE ROOM · room ABCD");
    expect(t).toContain("🏆 Ana wins with 500 pts (ended early)");
    expect(t).toContain("1. Ana 500 · 2. Ben 300 · 3. Cy 100");
    expect(t).toContain("🎯 Bullseye King: Ana (2 bullseyes)");
    expect(t).toContain("Closest call: Round 1: Ana & Ben nailed the room's 6.0 exactly");
    expect(t).toContain("R1 “Rate pineapple on pizza.”: room said 6.0 · closest: Ana");
    expect(t).toContain("R2 “Rate pineapple on pizza.”: not enough answers");
    expect(t).toContain("R3 ⟲ Who said it?: it was Ben · 1/2 right");
    expect(t.endsWith("Play: https://example.test")).toBe(true);
  });

  it("only names a Who Said It subject the report itself names", () => {
    const r = report.rounds[2]!;
    if (r.kind !== "echo") throw new Error();
    const name = (id: string) => ({ a: "Ana", b: "Ben" })[id] ?? "someone";
    expect(echoAnswer({ ...r, revealedSubject: null }, name)).toBe("—");
    expect(echoAnswer({ ...r, cancelled: true, revealedSubject: null }, name)).toBe("cancelled");
  });

  it("handles ties, missing names and empty reports", () => {
    expect(joinNames(["a", "b", "c"], (id) => id.toUpperCase())).toBe("A, B & C");
    const tie = reportText(
      { ...report, awards: [], moments: [], rounds: [], endedEarly: false },
      [{ ...standings[0]!, rank: 1 }, { ...standings[1]!, rank: 1, score: 500 }],
      players,
      "u",
    );
    expect(tie).toContain("🏆 Ana & Ben tie with 500 pts");
    expect(momentText({ kind: "best_echo", round: 3, mode: "count", correct: 2, guessers: 3 }, () => "x").body).toBe(
      "Round 3 Higher or lower: 2 of 3 got it",
    );
  });
});

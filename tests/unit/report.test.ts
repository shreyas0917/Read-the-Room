import { describe, expect, it } from "vitest";
import { migrateState } from "../../shared/engine";
import type { RoomState } from "../../shared/protocol";
import { viewFor } from "../../shared/redact";
import { buildReport } from "../../shared/report";
import type { RoundCount } from "../../shared/rules";
import { T0, echoAll, lobby, must, pid } from "./helpers";

type Plan = Record<number, { a: (number | null)[]; p: (number | null)[] }>;

/**
 * Plays a whole game. Regular rounds: `a` answers and `p` predictions per
 * player (null = doesn't submit, deadline passes). Echo rounds: `echo`
 * decides picks, defaulting to the first legal option.
 */
function play(
  n: number,
  rounds: RoundCount,
  plan: Plan,
  opts: { consent?: number[]; seed?: number; echo?: (s: RoomState, now: number) => RoomState; stopBefore?: number } = {},
): RoomState {
  let s = lobby(n, opts.seed);
  for (const i of opts.consent ?? []) s = must(s, { type: "consent", playerId: pid(i), value: true });
  s = must(s, { type: "settings", playerId: pid(1), rounds });
  s = must(s, { type: "start", playerId: pid(1) });
  let t = T0;
  while (s.phase !== "final") {
    if (opts.stopBefore && s.round === opts.stopBefore) break;
    // The clock only moves forward: Echo picks happen at the current time.
    if (s.phase === "echo") s = (opts.echo ?? echoAll)(s, t);
    else {
      const step = plan[s.round];
      if (!step) throw new Error(`no plan for round ${s.round}`);
      step.a.forEach((v, i) => v !== null && s.phase === "answer" && (s = must(s, { type: "answer", playerId: pid(i + 1), value: v }, t)));
      if (s.phase === "answer") s = must(s, { type: "tick" }, (t = s.deadline!));
      step.p.forEach((v, i) => v !== null && s.phase === "predict" && (s = must(s, { type: "predict", playerId: pid(i + 1), value: v }, t)));
      if (s.phase === "predict") s = must(s, { type: "tick" }, (t = s.deadline!));
    }
    s = must(s, { type: "next", playerId: pid(1) }, t);
  }
  return s;
}

const keysOf = (x: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(x)) x.forEach((v) => keysOf(v, out));
  else if (x && typeof x === "object")
    for (const [k, v] of Object.entries(x)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
};

// 3 players, 6 rounds (3 and 6 are Echo). Averages: r1 4, r2 7, r4 3, r5 8.
const BASE: Plan = {
  1: { a: [3, 4, 5], p: [4, 6, 5] }, // P1 exact (bullseye)
  2: { a: [6, 7, 8], p: [7, 9, 7.5] }, // P1 exact
  4: { a: [2, 3, 4], p: [3.2, 5, 4] }, // P1 0.2 (bullseye)
  5: { a: [7, 8, 9], p: [8, 8, 10] }, // P1 and P2 exact
};

describe("awards", () => {
  it("Mind Reader goes to the lowest average error; Bullseye King to the most bullseyes", () => {
    const r = buildReport(play(3, 6, BASE));
    const award = (id: string) => r.awards.find((a) => a.id === id);
    expect(award("mind_reader")?.winners).toEqual([pid(1)]);
    expect(award("mind_reader")?.value).toBeCloseTo(0.05);
    expect(award("bullseye_king")).toMatchObject({ winners: [pid(1)], value: 4 });
    expect(r.players.find((p) => p.playerId === pid(1))).toMatchObject({ predicted: 4, bullseyes: 4 });
  });

  it("Mind Reader needs real participation: one lucky exact guess doesn't win", () => {
    const plan: Plan = {
      1: { a: [3, 4, 5], p: [4, 5, 5.5] }, // P1 exact; P2 1.0; P3 1.5
      2: { a: [6, 7, 8], p: [null, 8, 8] }, // P1 skips; P2 1.0; P3 1.0
      4: { a: [2, 3, 4], p: [null, 4, 4.5] },
      5: { a: [7, 8, 9], p: [null, 9, 9.5] },
    };
    const r = buildReport(play(3, 6, plan));
    // P1: one prediction, error 0 → below the min of max(2, ceil(4/2)) = 2 predictions.
    expect(r.awards.find((a) => a.id === "mind_reader")?.winners).toEqual([pid(2)]);
  });

  it("exact ties share an award; an award everybody shares is skipped", () => {
    const tie: Plan = {
      1: { a: [3, 4, 5], p: [4, 4, 6] },
      2: { a: [6, 7, 8], p: [7, 7, 9] },
      4: { a: [2, 3, 4], p: [3, 3, 5] },
      5: { a: [7, 8, 9], p: [8, 8, 10] },
    };
    const r = buildReport(play(3, 6, tie));
    expect(r.awards.find((a) => a.id === "bullseye_king")?.winners).toEqual([pid(1), pid(2)]);
    const all: Plan = Object.fromEntries(Object.entries(tie).map(([k, v]) => [k, { a: v.a, p: [v.p[0]!, v.p[0]!, v.p[0]!] }]));
    expect(buildReport(play(3, 6, all)).awards.map((a) => a.id)).not.toContain("bullseye_king");
  });

  it("Wildcard counts the named Wildcard bonuses", () => {
    const plan: Plan = { ...BASE, 1: { a: [5, 5, 10], p: [6, 6, 6] }, 2: { a: [5, 5, 10], p: [6, 6, 6] } };
    expect(buildReport(play(3, 6, plan)).awards.find((a) => a.id === "wildcard")).toMatchObject({ winners: [pid(3)], value: 2 });
  });

  it("Echo Master uses Echo pick points; Poker Face goes to a Who Said It subject who fooled people", () => {
    // Find a seed where round 3 is Who Said It with everyone consenting.
    const plan: Plan = {
      1: { a: [4, 5, 6, 7], p: [5, 5, 5, 5] },
      2: { a: [1, 2, 3, 4], p: [5, 5, 5, 5] },
      4: { a: [7, 8, 9, 10], p: [5, 5, 5, 5] },
      5: { a: [3, 4, 4, 5], p: [5, 5, 5, 5] },
    };
    let found: RoomState | null = null;
    for (let seed = 1; seed < 300 && !found; seed++) {
      const s = play(4, 6, plan, { consent: [1, 2, 3, 4], seed, stopBefore: 4 });
      if (s.history.find((h) => h.index === 3)?.echo?.kind === "who") found = s;
    }
    expect(found).not.toBeNull();
    const r3 = found!.history.find((h) => h.index === 3)!;
    if (r3.echo?.kind !== "who") throw new Error();
    // echoAll: everyone picked option 0 (or 1 if 0 was themselves).
    const subject = r3.echo.subjectId;
    const wrong = r3.participants.filter((id) => id !== subject && r3.choices[id] !== r3.echo!.truth).length;
    const s = play(4, 6, plan, { consent: [1, 2, 3, 4], seed: found!.seed });
    const r = buildReport(s);
    const who = r.rounds.find((x) => x.index === 3);
    expect(who?.kind === "echo" && who.revealedSubject).toBe(subject);
    const poker = r.awards.find((a) => a.id === "poker_face");
    if (wrong > 0) expect(poker).toMatchObject({ winners: [subject], value: wrong });
    else expect(poker).toBeUndefined();
    const echoPts = r.players.map((p) => p.echoPoints);
    const best = Math.max(...echoPts);
    const master = r.awards.find((a) => a.id === "echo_master");
    const leaders = r.players.filter((p) => p.echoPoints === best).map((p) => p.playerId);
    if (best > 0 && leaders.length < r.players.length) expect(master).toMatchObject({ value: best, winners: leaders });
    else expect(master).toBeUndefined();
    // Subjects don't count as having "played" their own Who Said It.
    expect(r.players.find((p) => p.playerId === subject)?.echoPlayed).toBe(1); // round 6 only
  });
});

describe("report contents", () => {
  it("covers every played round, regular and Echo, in order", () => {
    const r = buildReport(play(3, 6, BASE));
    expect(r.rounds.map((x) => `${x.index}:${x.kind}`)).toEqual(["1:regular", "2:regular", "3:echo", "4:regular", "5:regular", "6:echo"]);
    expect(r).toMatchObject({ playedRounds: 6, totalRounds: 6, endedEarly: false });
    const r1 = r.rounds[0]!;
    expect(r1.kind === "regular" && r1.average).toBe(4);
    expect(r1.kind === "regular" && r1.closest).toEqual({ playerIds: [pid(1)], error: 0 });
  });

  it("highlights the closest call and the most divided / most agreed questions", () => {
    const plan: Plan = { ...BASE, 4: { a: [1, 5, 9], p: [5, 5, 5] } }; // r4 spread largest, everyone exact
    const r = buildReport(play(3, 6, plan));
    const m = (k: string) => r.moments.find((x) => x.kind === k);
    expect(m("closest_call")).toMatchObject({ round: 1, error: 0 }); // earliest exact call
    expect(m("most_divided")).toMatchObject({ round: 4 });
    expect(m("most_agreed")?.round).not.toBe(4);
  });

  it("handles a game with no Echo Rounds (ended early) and voided rounds", () => {
    let s = play(3, 6, BASE, { stopBefore: 3 });
    s = must(s, { type: "leave", playerId: pid(3) });
    s = must(s, { type: "leave", playerId: pid(2) });
    expect(s.phase).toBe("final");
    const r = buildReport(s);
    expect(r.endedEarly).toBe(true);
    expect(r.rounds.every((x) => x.kind === "regular")).toBe(true);
    expect(r.awards.map((a) => a.id)).not.toContain("echo_master");
    expect(r.players).toHaveLength(1); // only seated players appear

    const voided = buildReport(play(2, 6, { 1: { a: [null, null], p: [null, null] }, 2: { a: [3, 7], p: [5, 5] }, 4: { a: [4, 4], p: [4, 4] }, 5: { a: [2, 9], p: [5, 6] } }));
    const r1 = voided.rounds[0]!;
    expect(r1.kind === "regular" && r1).toMatchObject({ voided: true, average: null, spread: null, closest: null });
  });

  it("is deterministic and survives a storage round-trip", () => {
    const s = play(3, 6, BASE);
    expect(buildReport(migrateState(JSON.parse(JSON.stringify(s)))!)).toEqual(buildReport(s));
  });
});

describe("report privacy", () => {
  it("contains no hidden fields and no answer→player mapping", () => {
    const s = play(3, 6, BASE);
    const v = viewFor(s, pid(2), T0);
    const keys = keysOf(JSON.parse(JSON.stringify(v.report)));
    for (const k of ["answers", "predictions", "choices", "subjectId", "token", "tokens", "seed", "participants"]) {
      expect(keys.has(k), k).toBe(false);
    }
    // Every viewer gets the identical report: nothing personalised leaks in.
    expect(viewFor(s, pid(1), T0).report).toEqual(v.report);
    expect(viewFor(s, null, T0).report).toEqual(v.report);
  });

  it("never names anyone for non-consented or cancelled Echo Rounds", () => {
    const r = buildReport(play(3, 6, BASE));
    for (const x of r.rounds) if (x.kind === "echo") expect(x.revealedSubject).toBeNull();
  });

  it("does not name a Who Said It subject who left before the reveal", () => {
    const plan: Plan = {
      1: { a: [4, 5, 6, 7, 5], p: [5, 5, 5, 5, 5] },
      2: { a: [1, 2, 3, 4, 2], p: [5, 5, 5, 5, 5] },
      4: { a: [7, 8, 9, 10, 8], p: [5, 5, 5, 5] },
      5: { a: [3, 4, 4, 5, 4], p: [5, 5, 5, 5] },
    };
    let checked = false;
    for (let seed = 1; seed < 300 && !checked; seed++) {
      const leaveIfWho = (s: RoomState, now: number) => {
        const ch = s.current?.echo;
        if (ch?.kind === "who" && s.round === 3) s = must(s, { type: "leave", playerId: ch.subjectId }, now);
        return echoAll(s, now);
      };
      const s = play(5, 6, { ...plan, 4: { a: plan[4]!.a, p: plan[4]!.p }, 5: plan[5]! }, { consent: [1, 2, 3, 4, 5], seed, stopBefore: 4, echo: leaveIfWho });
      const r3 = s.history.find((h) => h.index === 3);
      if (r3?.echo?.kind !== "who") continue;
      expect(r3.voided).toBe(true);
      const rep = buildReport(s).rounds.find((x) => x.index === 3);
      expect(rep?.kind === "echo" && rep).toMatchObject({ cancelled: true, revealedSubject: null, correct: 0 });
      checked = true;
    }
    expect(checked).toBe(true);
  });

  it("is only sent on the final screen", () => {
    const s = play(3, 6, BASE, { stopBefore: 4 });
    expect(viewFor(s, pid(1), T0).report).toBeNull();
  });
});

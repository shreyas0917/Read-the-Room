import { describe, expect, it } from "vitest";
import { applyAction, createRoom, migrateState } from "../../shared/engine";
import { answersOf, echoCandidates, generateEcho, patternValue } from "../../shared/echo";
import { parseClientMessage, type EchoChallenge, type RoomState } from "../../shared/protocol";
import { viewFor } from "../../shared/redact";
import { DURATIONS, type RoundCount } from "../../shared/rules";
import { scoreEcho } from "../../shared/scoring";
import { T0, echoAll, errorOf, lobby, must, pid, playRound } from "./helpers";

/**
 * Plays a game up to the start of round `target`. Regular rounds use
 * `answers[round]` (players 1..n in order) with every prediction 5;
 * Echo Rounds use the first legal pick.
 */
function gameTo(
  target: number,
  n: number,
  answers: Record<number, number[]>,
  opts: { rounds?: RoundCount; consent?: number[]; seed?: number } = {},
): RoomState {
  let s = lobby(n, opts.seed);
  for (const i of opts.consent ?? []) s = must(s, { type: "consent", playerId: pid(i), value: true });
  s = must(s, { type: "settings", playerId: pid(1), rounds: opts.rounds ?? 12 });
  s = must(s, { type: "start", playerId: pid(1) });
  while (s.round < target) {
    if (s.phase === "echo") s = echoAll(s);
    else {
      const a = answers[s.round];
      if (!a) throw new Error(`no answers for round ${s.round}`);
      s = playRound(s, a, a.map(() => 5));
    }
    s = must(s, { type: "next", playerId: pid(1) });
  }
  return s;
}

/** Spreads with no Wildcard (max distance < 2) and distinct averages. */
const CALM: Record<number, number[]> = {
  1: [4, 5, 6, 7],
  2: [1, 2, 3, 4],
  4: [7, 8, 9, 10],
  5: [3, 4, 4, 5],
  7: [5, 6, 6, 7],
  8: [2, 3, 3, 4],
  10: [6, 7, 7, 8],
  11: [4, 4, 5, 6],
};

const keysOf = (x: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(x)) x.forEach((v) => keysOf(v, out));
  else if (x && typeof x === "object")
    for (const [k, v] of Object.entries(x)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
};

function current(s: RoomState): EchoChallenge {
  const ch = s.current?.echo;
  if (!ch) throw new Error(`round ${s.round} is not an echo round (phase ${s.phase})`);
  return ch;
}

describe("Echo Round scheduling", () => {
  it("makes rounds 3, 6, 9, 12 Echo Rounds and keeps the rest regular", () => {
    let s = gameTo(12, 4, CALM);
    expect(s.phase).toBe("echo");
    s = echoAll(s);
    s = must(s, { type: "next", playerId: pid(1) });
    expect(s.phase).toBe("final");
    expect(s.history.map((h) => h.kind)).toEqual([
      "regular", "regular", "echo", "regular", "regular", "echo",
      "regular", "regular", "echo", "regular", "regular", "echo",
    ]);
  });

  it("falls back to a regular round when no history is eligible", () => {
    let s = gameTo(1, 2, {}, { rounds: 6 });
    // Nobody answers rounds 1 and 2 → both voided → nothing to echo.
    let t = T0;
    for (let i = 0; i < 4; i++) {
      t = s.deadline!;
      s = must(s, { type: "tick" }, t);
    }
    expect(s.history.map((h) => h.voided)).toEqual([true, true]);
    expect(s.round).toBe(3);
    expect(s.phase).toBe("answer");
    expect(s.current?.kind).toBe("regular");
  });

  it("uses every mode over a 12-round game when players consent", () => {
    let s = gameTo(12, 4, CALM, { consent: [1, 2, 3, 4] });
    s = echoAll(s);
    const kinds = [...s.history.map((h) => h.echo?.kind), s.current?.echo?.kind].filter(Boolean);
    expect(new Set(kinds)).toEqual(new Set(["count", "pattern", "who"]));
  });

  it("never offers Who Said It without consent", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      let s = gameTo(12, 4, CALM, { seed });
      s = echoAll(s);
      const kinds = [...s.history.map((h) => h.echo?.kind), s.current?.echo?.kind];
      expect(kinds).not.toContain("who");
    }
  });
});

describe("determinism and persistence", () => {
  it("generates the same challenge from the same persisted state", () => {
    const s = gameTo(3, 4, CALM, { consent: [1, 2] });
    const before = s.current?.echo;
    const roundTripped = migrateState(JSON.parse(JSON.stringify(s)))!;
    // Rebuild the pre-round history exactly as storage would hand it back.
    const pre: RoomState = { ...roundTripped, current: null };
    expect(generateEcho(pre, 3)).toEqual(before);
    expect(generateEcho(pre, 3)).toEqual(generateEcho(pre, 3));
  });

  it("keeps the stored question through reconnects and a storage round-trip", () => {
    let s = gameTo(3, 3, { 1: [2, 5, 9], 2: [4, 6, 7] });
    const q = structuredClone(s.current?.echo);
    s = must(s, { type: "disconnect", playerId: pid(2) });
    s = migrateState(JSON.parse(JSON.stringify(s)))!; // simulated restart
    s = must(s, { type: "connect", playerId: pid(2) });
    expect(s.current?.echo).toEqual(q);
    expect(viewFor(s, pid(2), T0).echo?.kind).toBe(q?.kind);
  });

  it("migrates v1 rooms saved before Echo Rounds existed", () => {
    const v1 = JSON.parse(JSON.stringify(gameTo(2, 2, { 1: [3, 7] })));
    v1.v = 1;
    for (const p of Object.values(v1.players) as Record<string, unknown>[]) delete p.onRecord;
    for (const r of [...v1.history, v1.current]) {
      delete r.kind;
      delete r.echo;
      delete r.choices;
      for (const sc of Object.values(r.scores) as Record<string, unknown>[]) delete sc.mystery;
    }
    const s = migrateState(v1)!;
    expect(s.v).toBe(2);
    expect(s.history[0]?.kind).toBe("regular");
    expect(s.current?.choices).toEqual({});
    expect(Object.values(s.players).every((p) => p.onRecord === false)).toBe(true);
    // The migrated room keeps playing.
    const next = playRound(s, [5, 5], [5, 5]);
    expect(next.phase).toBe("reveal");
    expect(migrateState({ v: 99 })).toBeNull();
    expect(migrateState(null)).toBeNull();
  });
});

describe("Higher or Lower", () => {
  it("asks about a non-trivial threshold of an earlier round", () => {
    const s = gameTo(3, 3, { 1: [2, 5, 9], 2: [4, 6, 7] });
    const ch = current(s);
    expect(ch.kind).toBe("count");
    if (ch.kind !== "count") return;
    const src = s.history.find((h) => h.index === ch.sourceRound)!;
    const vals = answersOf(src);
    expect(ch.max).toBe(vals.length);
    expect(ch.truth).toBe(vals.filter((v) => v > ch.threshold).length);
    expect(ch.truth).toBeGreaterThan(0);
    expect(ch.truth).toBeLessThan(ch.max);
  });

  it("scores exact 100, off-by-one 50, otherwise and no pick 0", () => {
    const ch: EchoChallenge = { kind: "count", sourceRound: 1, promptId: "p01", threshold: 5, max: 4, truth: 2 };
    const sc = scoreEcho(ch, ["a", "b", "c", "d", "e"], { a: 2, b: 1, c: 3, d: 4 });
    expect([sc.a, sc.b, sc.c, sc.d, sc.e].map((x) => x?.total)).toEqual([100, 50, 50, 0, 0]);
  });

  it("skips rounds where everyone gave the same answer", () => {
    const s = gameTo(3, 3, { 1: [5, 5, 5], 2: [5, 5, 5] });
    expect(s.current?.kind).toBe("regular"); // nothing meaningful to ask
  });
});

describe("Room Pattern", () => {
  it("picks a metric with a clear winner among three earlier prompts", () => {
    const s = gameTo(6, 4, CALM, { rounds: 6 });
    const c = echoCandidates({ ...s, current: null }, 6).find((x) => x.kind === "pattern");
    expect(c).toBeDefined();
    if (c?.kind !== "pattern") return;
    expect(new Set(c.options.map((o) => o.round)).size).toBe(3);
    const values = c.options.map((o) => patternValue(s.history.find((h) => h.index === o.round)!, c.metric));
    const sorted = [...values].sort((a, b) => b - a);
    expect(values[c.truth]).toBe(sorted[0]);
    expect(sorted[0]! - sorted[1]!).toBeGreaterThanOrEqual(0.1 - 1e-9);
  });

  it("is not offered before three eligible rounds exist", () => {
    const s = gameTo(3, 4, CALM);
    expect(echoCandidates({ ...s, current: null }, 3).map((c) => c.kind)).not.toContain("pattern");
  });

  it("is not offered when no metric has a clear winner", () => {
    const same = { 1: [4, 6, 4, 6], 2: [4, 6, 4, 6], 4: [4, 6, 4, 6], 5: [4, 6, 4, 6] };
    const s = gameTo(6, 4, same, { rounds: 6 });
    expect(echoCandidates({ ...s, current: null }, 6).map((c) => c.kind)).not.toContain("pattern");
  });

  it("scores the correct pick 100", () => {
    const ch: EchoChallenge = { kind: "pattern", metric: "split", options: [{ round: 1, promptId: "p01" }, { round: 2, promptId: "p02" }, { round: 4, promptId: "p03" }], truth: 1 };
    const sc = scoreEcho(ch, ["a", "b"], { a: 1, b: 2 });
    expect([sc.a?.total, sc.b?.total]).toEqual([100, 0]);
  });
});

describe("Who Said It (opt-in)", () => {
  const who = (s: RoomState) => echoCandidates({ ...s, current: null }, s.round).find((c) => c.kind === "who");

  it("only names consenting players with a unique, non-Wildcard answer", () => {
    // Round 1: P3's 9 is the Wildcard (already named) → not eligible.
    // Round 2: [3,5,6]: no wildcard; all unique.
    const answers = { 1: [2, 4, 9], 2: [3, 5, 6] };
    expect(who(gameTo(3, 3, answers))).toBeUndefined(); // nobody consented
    const c = who(gameTo(3, 3, answers, { consent: [3] }));
    expect(c?.kind === "who" && c.sourceRound).toBe(2);
    expect(c?.kind === "who" && c.subjectId).toBe(pid(3));
    expect(c?.kind === "who" && c.value).toBe(6);
  });

  it("needs at least three answers in the source round", () => {
    expect(who(gameTo(3, 2, { 1: [2, 8], 2: [3, 6] }, { consent: [1, 2] }))).toBeUndefined();
  });

  it("never uses a duplicated answer", () => {
    expect(who(gameTo(3, 3, { 1: [5, 5, 6], 2: [5, 5, 6] }, { consent: [1, 2] }))).toBeUndefined();
  });

  it("consent is lobby-only and private", () => {
    let s = lobby(3);
    s = must(s, { type: "consent", playerId: pid(2), value: true });
    const v1 = viewFor(s, pid(1), T0);
    expect(v1.onRecordCount).toBe(1);
    expect(v1.you?.onRecord).toBe(false);
    expect(keysOf(v1.players).has("onRecord")).toBe(false); // nobody else's flag
    expect(viewFor(s, pid(2), T0).you?.onRecord).toBe(true);
    s = must(s, { type: "start", playerId: pid(1) });
    expect(errorOf(s, { type: "consent", playerId: pid(2), value: false })).toBe("wrong_phase");
  });

  function whoRound(): RoomState {
    // Find a seed where round 3 is a Who Said It round for 4 consenting players.
    for (let seed = 1; seed < 200; seed++) {
      const s = gameTo(3, 4, { 1: [4, 5, 6, 7], 2: [1, 2, 3, 4] }, { consent: [1, 2, 3, 4], seed });
      if (s.current?.echo?.kind === "who") return s;
    }
    throw new Error("no who round found");
  }

  it("hides the subject from everyone but the subject, and the subject plays too", () => {
    const s = whoRound();
    const ch = current(s);
    if (ch.kind !== "who") throw new Error();
    const subject = ch.subjectId;
    const other = ch.options.find((id) => id !== subject)!;
    const vo = viewFor(s, other, T0);
    expect(vo.echo?.youAreSubject).toBe(false);
    expect(vo.echo?.result).toBeNull();
    const keys = keysOf(JSON.parse(JSON.stringify(vo)));
    for (const k of ["subjectId", "truth", "choices", "answers"]) expect(keys.has(k), k).toBe(false);
    expect(viewFor(s, subject, T0).echo?.youAreSubject).toBe(true);
    // The subject is a normal participant, so the "locked in" strip can't single them out.
    expect(vo.players.every((p) => p.submitted === false)).toBe(true);
    expect(vo.expectedCount).toBe(4);
  });

  it("rejects picking yourself; scores guessers and the subject's fooled bonus", () => {
    let s = whoRound();
    const ch = current(s);
    if (ch.kind !== "who") throw new Error();
    const [g1, g2, g3] = ch.options.filter((id) => id !== ch.subjectId) as [string, string, string];
    const wrong = (id: string) => ch.options.findIndex((o) => o !== id && o !== ch.subjectId);
    expect(errorOf(s, { type: "echo", playerId: g1, choice: ch.options.indexOf(g1) })).toBe("invalid_value");
    s = must(s, { type: "echo", playerId: g1, choice: ch.truth });
    s = must(s, { type: "echo", playerId: g2, choice: wrong(g2) });
    s = must(s, { type: "echo", playerId: g3, choice: wrong(g3) });
    s = must(s, { type: "echo", playerId: ch.subjectId, choice: wrong(ch.subjectId) });
    expect(s.phase).toBe("echo_reveal");
    const sc = s.current!.scores;
    expect([sc[g1]?.total, sc[g2]?.total, sc[g3]?.total]).toEqual([100, 0, 0]);
    expect(sc[ch.subjectId]).toMatchObject({ base: 0, mystery: 50, total: 50 });
    const v = viewFor(s, g2, T0);
    expect(v.echo?.result?.subjectId).toBe(ch.subjectId);
    expect(v.echo?.result?.picks.find((p) => p.playerId === g1)?.choice).toBe(ch.truth);
  });

  it("caps the fooled bonus at 100", () => {
    const ch: EchoChallenge = { kind: "who", sourceRound: 1, promptId: "p01", value: 9, subjectId: "s", options: ["s", "a", "b", "c", "d", "e"], truth: 0 };
    const sc = scoreEcho(ch, ["s", "a", "b", "c", "d", "e"], { a: 2, b: 2, c: 2, d: 2, e: 2 });
    expect(sc.s?.mystery).toBe(100);
  });

  it("cancels the round and names nobody if the subject leaves", () => {
    let s = whoRound();
    const ch = current(s);
    if (ch.kind !== "who") throw new Error();
    const others = ch.options.filter((id) => id !== ch.subjectId);
    s = must(s, { type: "echo", playerId: others[0]!, choice: ch.truth });
    s = must(s, { type: "leave", playerId: ch.subjectId });
    for (const id of others.slice(1)) s = must(s, { type: "echo", playerId: id, choice: ch.truth });
    expect(s.phase).toBe("echo_reveal");
    const v = viewFor(s, others[0]!, T0);
    expect(v.echo?.result?.cancelled).toBe(true);
    expect(v.echo?.result?.subjectId).toBeNull();
    expect(Object.values(s.current!.scores).every((x) => x.total === 0)).toBe(true);
  });

  it("names each player at most once per game", () => {
    let s = gameTo(12, 4, CALM, { consent: [1, 2, 3, 4] });
    s = echoAll(s);
    const subjects = [...s.history, s.current!].flatMap((r) => (r.echo?.kind === "who" ? [r.echo.subjectId] : []));
    expect(new Set(subjects).size).toBe(subjects.length);
  });
});

describe("Echo Round validation and flow", () => {
  const s3 = () => gameTo(3, 3, { 1: [2, 5, 9], 2: [4, 6, 7] });

  it("rejects wrong-phase, duplicate, out-of-range and unauthorized picks", () => {
    let s = s3();
    expect(s.phase).toBe("echo");
    const ch = current(s);
    expect(errorOf(s, { type: "answer", playerId: pid(1), value: 5 })).toBe("wrong_phase");
    expect(errorOf(s, { type: "predict", playerId: pid(1), value: 5 })).toBe("wrong_phase");
    expect(errorOf(s, { type: "echo", playerId: pid(1), choice: 99 })).toBe("invalid_value");
    expect(errorOf(s, { type: "echo", playerId: pid(1), choice: -1 })).toBe("invalid_value");
    expect(errorOf(s, { type: "echo", playerId: pid(1), choice: 1.5 })).toBe("invalid_value");
    expect(errorOf(s, { type: "echo", playerId: pid(42), choice: 0 })).toBe("not_joined");
    s = must(s, { type: "join", playerId: pid(9), name: "Late" });
    expect(errorOf(s, { type: "echo", playerId: pid(9), choice: 0 })).toBe("not_participant");
    s = must(s, { type: "echo", playerId: pid(1), choice: 0 });
    expect(errorOf(s, { type: "echo", playerId: pid(1), choice: 1 })).toBe("already_submitted");
    expect(s.current?.choices[pid(1)]).toBe(0);
    expect(errorOf(s, { type: "next", playerId: pid(1) })).toBe("wrong_phase");
    s = must(s, { type: "echo", playerId: pid(2), choice: 0 });
    s = must(s, { type: "echo", playerId: pid(3), choice: ch.kind === "count" ? ch.truth : 0 });
    expect(s.phase).toBe("echo_reveal");
    expect(errorOf(s, { type: "echo", playerId: pid(1), choice: 0 })).toBe("wrong_phase");
    expect(errorOf(s, { type: "next", playerId: pid(2) })).toBe("not_host");
    s = must(s, { type: "next", playerId: pid(1) });
    expect(s.round).toBe(4);
    expect(s.phase).toBe("answer");
  });

  it("does not reveal the answer or anyone's pick before the reveal", () => {
    let s = s3();
    s = must(s, { type: "echo", playerId: pid(2), choice: 1 });
    const v = viewFor(s, pid(1), T0);
    const keys = keysOf(JSON.parse(JSON.stringify(v)));
    for (const k of ["truth", "choices", "answers", "predictions", "subjectId"]) expect(keys.has(k), k).toBe(false);
    expect(v.mine.echo).toBeNull();
    expect(viewFor(s, pid(2), T0).mine.echo).toBe(1);
    expect(v.players.find((p) => p.id === pid(2))?.submitted).toBe(true);
    expect(v.prompt).toBeNull(); // the reserved prompt isn't shown
    expect(v.echo?.first).toBe(true);
  });

  it("advances on the deadline when nobody picks, scoring 0", () => {
    let s = s3();
    const scores = Object.values(s.players).map((p) => p.score);
    s = must(s, { type: "tick" }, s.deadline! - 1);
    expect(s.phase).toBe("echo");
    s = must(s, { type: "tick" }, s.deadline!);
    expect(s.phase).toBe("echo_reveal");
    expect(Object.values(s.players).map((p) => p.score)).toEqual(scores);
    s = must(s, { type: "tick" }, s.deadline!);
    expect(s.phase).toBe("answer");
  });

  it("a disconnected player doesn't block the Echo Round and keeps their seat", () => {
    let s = s3();
    s = must(s, { type: "disconnect", playerId: pid(3) });
    s = must(s, { type: "echo", playerId: pid(1), choice: 0 });
    s = must(s, { type: "echo", playerId: pid(2), choice: 0 });
    expect(s.phase).toBe("echo_reveal");
    expect(s.current?.scores[pid(3)]?.total).toBe(0);
    s = must(s, { type: "connect", playerId: pid(3) });
    expect(viewFor(s, pid(3), T0).echo?.result).not.toBeNull();
  });

  it("reconnecting mid-Echo keeps your own pick", () => {
    let s = s3();
    s = must(s, { type: "echo", playerId: pid(3), choice: 1 });
    s = must(s, { type: "disconnect", playerId: pid(3) });
    s = must(s, { type: "connect", playerId: pid(3) });
    expect(viewFor(s, pid(3), T0).mine.echo).toBe(1);
    expect(errorOf(s, { type: "echo", playerId: pid(3), choice: 0 })).toBe("already_submitted");
  });

  it("discards the pick of a player who leaves mid-Echo", () => {
    let s = gameTo(3, 4, CALM);
    s = must(s, { type: "echo", playerId: pid(4), choice: 0 });
    s = must(s, { type: "leave", playerId: pid(4) });
    expect(s.current?.choices[pid(4)]).toBeUndefined();
    expect(s.current?.participants).not.toContain(pid(4));
  });

  it("uses the echo durations and the timer scale", () => {
    let s = createRoom("ABCD", 7, T0, 0.1);
    s = must(s, { type: "join", playerId: pid(1), name: "A" });
    s = must(s, { type: "join", playerId: pid(2), name: "B" });
    s = must(s, { type: "start", playerId: pid(1) });
    for (const a of [[2, 8], [3, 6]]) {
      s = playRound(s, a, [5, 5]);
      s = must(s, { type: "next", playerId: pid(1) });
    }
    expect(s.phase).toBe("echo");
    expect(s.deadline).toBe(T0 + DURATIONS.echo * 0.1);
  });

  it("ends early from an Echo Round if too few players remain", () => {
    let s = gameTo(3, 2, { 1: [2, 8], 2: [3, 6] });
    expect(s.phase).toBe("echo");
    s = must(s, { type: "leave", playerId: pid(2) });
    expect(s.phase).toBe("final");
    expect(s.endedEarly).toBe(true);
  });

  it("never mutates the input state", () => {
    const s = s3();
    const before = JSON.stringify(s);
    applyAction(s, { type: "echo", playerId: pid(1), choice: 0 }, T0);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("protocol", () => {
  const p = (o: unknown) => parseClientMessage(JSON.stringify(o));
  it("validates echo and consent messages", () => {
    expect(p({ t: "echo", choice: 2 })).toEqual({ ok: true, msg: { t: "echo", choice: 2 } });
    expect(p({ t: "echo", choice: "2" }).ok).toBe(false);
    expect(p({ t: "echo", choice: 2.5 }).ok).toBe(false);
    expect(p({ t: "echo", choice: -1 }).ok).toBe(false);
    expect(p({ t: "echo", choice: 999 }).ok).toBe(false);
    expect(p({ t: "echo", choice: 1, playerId: "x" }).ok).toBe(false);
    expect(p({ t: "consent", value: true })).toEqual({ ok: true, msg: { t: "consent", value: true } });
    expect(p({ t: "consent", value: "yes" }).ok).toBe(false);
    expect(p({ t: "consent" }).ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { viewFor } from "../../shared/redact";
import type { ClientView } from "../../shared/protocol";
import { T0, must, pid, playAny, playRound, started } from "./helpers";

/** Recursively collects every key in a JSON value. */
function keysOf(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) x.forEach((v) => keysOf(v, out));
  else if (x && typeof x === "object") {
    for (const [k, v] of Object.entries(x)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

const FORBIDDEN_KEYS = ["answers", "predictions", "choices", "subjectId", "tokens", "token", "tokenHash", "seed", "prompts", "participants"];

function assertNoSecrets(v: ClientView) {
  const keys = keysOf(JSON.parse(JSON.stringify(v)));
  for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `view leaked key "${k}"`).toBe(false);
}

describe("redaction", () => {
  it("during ANSWER, a player sees only their own answer and who has submitted", () => {
    let s = started(3);
    s = must(s, { type: "answer", playerId: pid(2), value: 9 });
    const v1 = viewFor(s, pid(1), T0);
    const v2 = viewFor(s, pid(2), T0);
    assertNoSecrets(v1);
    expect(v1.mine.answer).toBeNull();
    expect(v2.mine.answer).toBe(9);
    expect(v1.players.find((p) => p.id === pid(2))?.submitted).toBe(true);
    expect(v1.submittedCount).toBe(1);
    expect(v1.reveal).toBeNull();
    // P2's value appears nowhere in P1's view as an answer.
    expect(JSON.stringify(v1)).not.toMatch(/"answer":9/);
  });

  it("during PREDICT, other players' predictions are hidden", () => {
    let s = started(2);
    s = must(s, { type: "answer", playerId: pid(1), value: 3 });
    s = must(s, { type: "answer", playerId: pid(2), value: 7 });
    s = must(s, { type: "predict", playerId: pid(2), value: 6.4 });
    const v1 = viewFor(s, pid(1), T0);
    assertNoSecrets(v1);
    expect(v1.mine).toEqual({ answer: 3, prediction: null, echo: null });
    expect(JSON.stringify(v1)).not.toContain("6.4");
  });

  it("at REVEAL, answers are anonymous counts; only your own answer is identified", () => {
    const s = playRound(started(3), [2, 4, 9], [5, 5, 5]);
    const v = viewFor(s, pid(1), T0);
    assertNoSecrets(v);
    expect(v.reveal?.counts).toEqual([0, 1, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(v.reveal?.yourAnswer).toBe(2);
    expect(v.reveal?.answerCount).toBe(3);
    // Prediction entries carry no answer field.
    for (const p of v.reveal?.guesses ?? []) expect(Object.keys(p).sort()).toEqual(["playerId", "score", "value"]);
  });

  it("a spectator or unknown viewer sees no personal data", () => {
    let s = started(2);
    s = must(s, { type: "answer", playerId: pid(1), value: 8 });
    const v = viewFor(s, null, T0);
    assertNoSecrets(v);
    expect(v.you).toBeNull();
    expect(v.mine).toEqual({ answer: null, prediction: null, echo: null });
  });

  it("the final recap exposes only per-prompt aggregates", () => {
    let s = started(2, 6);
    for (let r = 1; r <= 6; r++) {
      s = playAny(s, [3, 8], [5, 5]);
      s = must(s, { type: "next", playerId: pid(1) });
    }
    const v = viewFor(s, pid(2), T0);
    assertNoSecrets(v);
    expect(v.rounds).toHaveLength(4); // regular rounds only
    expect(v.standings?.map((x) => x.rank)).toEqual([1, 1]);
  });
});

import { describe, expect, it } from "vitest";
import { DURATIONS } from "../../shared/rules";
import { T0, errorOf, must, pid, playRound, started } from "./helpers";

// A submission that reaches the server after the phase deadline must not
// count, even if the alarm that advances the phase hasn't fired yet.
describe("deadlines are enforced at submission time", () => {
  it("rejects an answer that arrives after the deadline, before the alarm runs", () => {
    const s = started(3);
    const deadline = s.deadline!;
    expect(deadline).toBe(T0 + DURATIONS.answer);
    expect(errorOf(s, { type: "answer", playerId: pid(1), value: 5 }, deadline - 1)).toBeNull();
    expect(errorOf(s, { type: "answer", playerId: pid(1), value: 5 }, deadline)).toBe("wrong_phase");
    expect(errorOf(s, { type: "answer", playerId: pid(1), value: 5 }, deadline + 5000)).toBe("wrong_phase");
  });

  it("rejects a late prediction and a late Echo pick the same way", () => {
    let s = started(2);
    s = must(s, { type: "answer", playerId: pid(1), value: 3 });
    s = must(s, { type: "answer", playerId: pid(2), value: 7 });
    expect(s.phase).toBe("predict");
    expect(errorOf(s, { type: "predict", playerId: pid(1), value: 5 }, s.deadline!)).toBe("wrong_phase");
    // Into the round-3 Echo Round, then pick one millisecond too late.
    s = must(s, { type: "predict", playerId: pid(1), value: 5 });
    s = must(s, { type: "predict", playerId: pid(2), value: 5 });
    s = must(s, { type: "next", playerId: pid(1) });
    s = playRound(s, [2, 8], [5, 5]);
    s = must(s, { type: "next", playerId: pid(1) });
    expect(s.phase).toBe("echo");
    expect(errorOf(s, { type: "echo", playerId: pid(1), choice: 0 }, s.deadline! - 1)).toBeNull();
    expect(errorOf(s, { type: "echo", playerId: pid(1), choice: 0 }, s.deadline! + 1)).toBe("wrong_phase");
  });

  it("a host Next after the reveal deadline doesn't skip an extra round", () => {
    let s = started(2);
    s = must(s, { type: "answer", playerId: pid(1), value: 3 });
    s = must(s, { type: "answer", playerId: pid(2), value: 7 });
    s = must(s, { type: "predict", playerId: pid(1), value: 5 });
    s = must(s, { type: "predict", playerId: pid(2), value: 5 });
    expect(s.phase).toBe("reveal");
    // Reveal already expired: the deadline moves to round 2 first, so Next is
    // no longer valid instead of jumping ahead to round 3.
    expect(errorOf(s, { type: "next", playerId: pid(1) }, s.deadline! + 1)).toBe("wrong_phase");
  });
});

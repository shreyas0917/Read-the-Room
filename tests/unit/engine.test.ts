import { describe, expect, it } from "vitest";
import { applyAction, createRoom, isAbandoned, nextWakeTime } from "../../shared/engine";
import { ABANDON_MS, DURATIONS, HOST_GRACE_MS, LOBBY_GRACE_MS, MAX_PLAYERS } from "../../shared/rules";
import { T0, errorOf, lobby, must, pid, playAny, playRound, started } from "./helpers";

describe("lobby", () => {
  it("makes the first joiner host and assigns distinct avatars and seats", () => {
    const s = lobby(3);
    expect(s.hostId).toBe(pid(1));
    expect(new Set(Object.values(s.players).map((p) => p.avatar)).size).toBe(3);
    expect(Object.values(s.players).map((p) => p.seat)).toEqual([0, 1, 2]);
  });
  it("rejects duplicate names case-insensitively and invalid names", () => {
    const s = lobby(1);
    expect(errorOf(s, { type: "join", playerId: pid(9), name: "p1" })).toBe("name_taken");
    expect(errorOf(s, { type: "join", playerId: pid(9), name: "   " })).toBe("invalid_name");
    expect(errorOf(s, { type: "join", playerId: pid(9), name: "x".repeat(17) })).toBe("invalid_name");
    expect(errorOf(s, { type: "join", playerId: pid(1), name: "Again" })).toBe("already_joined");
  });
  it("caps the room at 8 players", () => {
    const s = lobby(MAX_PLAYERS);
    expect(errorOf(s, { type: "join", playerId: pid(99), name: "Nine" })).toBe("room_full");
  });
  it("only the host can change settings or start, and only in the lobby", () => {
    const s = lobby(2);
    expect(errorOf(s, { type: "settings", playerId: pid(2), rounds: 12 })).toBe("not_host");
    expect(errorOf(s, { type: "start", playerId: pid(2) })).toBe("not_host");
    expect(must(s, { type: "settings", playerId: pid(1), rounds: 12 }).settings.rounds).toBe(12);
    const g = must(s, { type: "start", playerId: pid(1) });
    expect(errorOf(g, { type: "settings", playerId: pid(1), rounds: 6 })).toBe("wrong_phase");
    expect(errorOf(g, { type: "start", playerId: pid(1) })).toBe("wrong_phase");
  });
  it("needs two connected players to start", () => {
    expect(errorOf(lobby(1), { type: "start", playerId: pid(1) })).toBe("not_enough_players");
    const s = must(lobby(2), { type: "disconnect", playerId: pid(2) });
    expect(errorOf(s, { type: "start", playerId: pid(1) })).toBe("not_enough_players");
  });
  it("is deterministic: same seed, same prompts", () => {
    expect(started(3).prompts).toEqual(started(3).prompts);
    expect(new Set(started(3, 12).prompts).size).toBe(12);
  });
});

describe("round flow", () => {
  it("answer → predict → reveal, advancing early when everyone submits", () => {
    let s = started(3);
    expect(s.phase).toBe("answer");
    expect(s.deadline).toBe(T0 + DURATIONS.answer);
    s = must(s, { type: "answer", playerId: pid(1), value: 2 });
    s = must(s, { type: "answer", playerId: pid(2), value: 4 });
    expect(s.phase).toBe("answer");
    s = must(s, { type: "answer", playerId: pid(3), value: 9 });
    expect(s.phase).toBe("predict");
    s = must(s, { type: "predict", playerId: pid(1), value: 5 });
    s = must(s, { type: "predict", playerId: pid(2), value: 5 });
    s = must(s, { type: "predict", playerId: pid(3), value: 5 });
    expect(s.phase).toBe("reveal");
    expect(s.current?.average).toBeCloseTo(5);
    expect(s.players[pid(1)]?.score).toBe(150);
    expect(s.players[pid(1)]?.bullseyes).toBe(1);
  });

  it("rejects duplicate, out-of-phase and invalid submissions", () => {
    let s = started(2);
    expect(errorOf(s, { type: "predict", playerId: pid(1), value: 5 })).toBe("wrong_phase");
    expect(errorOf(s, { type: "answer", playerId: pid(1), value: 0 })).toBe("invalid_value");
    expect(errorOf(s, { type: "answer", playerId: pid(1), value: 11 })).toBe("invalid_value");
    expect(errorOf(s, { type: "answer", playerId: pid(1), value: 5.5 })).toBe("invalid_value");
    expect(errorOf(s, { type: "answer", playerId: pid(1), value: Number.NaN })).toBe("invalid_value");
    s = must(s, { type: "answer", playerId: pid(1), value: 5 });
    expect(errorOf(s, { type: "answer", playerId: pid(1), value: 6 })).toBe("already_submitted");
    expect(s.current?.answers[pid(1)]).toBe(5); // cannot change an answer
    expect(errorOf(s, { type: "answer", playerId: pid(77), value: 5 })).toBe("not_joined");
    expect(errorOf(s, { type: "next", playerId: pid(1) })).toBe("wrong_phase");
  });

  it("only the host can skip the reveal", () => {
    const s = playRound(started(2), [3, 7], [5, 5]);
    expect(s.phase).toBe("reveal");
    expect(errorOf(s, { type: "next", playerId: pid(2) })).toBe("not_host");
    const n = must(s, { type: "next", playerId: pid(1) });
    expect(n.phase).toBe("answer");
    expect(n.round).toBe(2);
    expect(n.history).toHaveLength(1);
  });

  it("plays a full game to the final screen and then rematches with reset scores", () => {
    let s = started(2, 6);
    for (let r = 1; r <= 6; r++) {
      s = playAny(s, [4, 6], [5, 4]);
      s = must(s, { type: "next", playerId: pid(1) });
    }
    expect(s.phase).toBe("final");
    expect(s.deadline).toBeNull();
    expect(s.history).toHaveLength(6);
    expect(s.history.map((h) => h.kind)).toEqual(["regular", "regular", "echo", "regular", "regular", "echo"]);
    const regular = s.history.filter((h) => h.kind === "regular").length;
    const echoPoints = s.history.filter((h) => h.kind === "echo").reduce((n, h) => n + (h.scores[pid(1)]?.total ?? 0), 0);
    expect(s.players[pid(1)]?.score).toBe(regular * 150 + echoPoints);
    expect(errorOf(s, { type: "play_again", playerId: pid(2) })).toBe("not_host");
    s = must(s, { type: "play_again", playerId: pid(1) });
    expect(s.phase).toBe("lobby");
    expect(s.gameNumber).toBe(2);
    expect(Object.values(s.players).every((p) => p.score === 0 && p.bullseyes === 0)).toBe(true);
    const again = must(s, { type: "start", playerId: pid(1) });
    expect(again.prompts).not.toEqual(started(2, 6).prompts); // new seed mix per game
  });
});

describe("deadlines", () => {
  it("advance with nobody submitting: an empty answer phase voids the round", () => {
    let s = started(2);
    s = must(s, { type: "tick" }, T0 + DURATIONS.answer - 1);
    expect(s.phase).toBe("answer");
    s = must(s, { type: "tick" }, T0 + DURATIONS.answer);
    expect(s.phase).toBe("reveal");
    expect(s.current?.voided).toBe(true);
    s = must(s, { type: "tick" }, T0 + DURATIONS.answer + DURATIONS.reveal);
    expect(s.phase).toBe("answer");
    expect(s.round).toBe(2);
    expect(Object.values(s.players).every((p) => p.score === 0)).toBe(true);
  });
  it("move on to predict when two answered and the rest timed out", () => {
    let s = started(3);
    s = must(s, { type: "answer", playerId: pid(1), value: 3 });
    s = must(s, { type: "answer", playerId: pid(2), value: 5 });
    s = must(s, { type: "tick" }, T0 + DURATIONS.answer);
    expect(s.phase).toBe("predict");
    const t = T0 + DURATIONS.answer;
    s = must(s, { type: "predict", playerId: pid(3), value: 4 }, t + 1);
    s = must(s, { type: "tick" }, t + DURATIONS.predict);
    expect(s.phase).toBe("reveal");
    expect(s.current?.scores[pid(3)]?.base).toBe(100); // non-answerer may still predict
    expect(s.current?.scores[pid(1)]?.total).toBe(0); // no prediction → 0
  });
  it("respect the timer scale", () => {
    let s = createRoom("ABCD", 1, T0, 0.1);
    s = must(s, { type: "join", playerId: pid(1), name: "A" });
    s = must(s, { type: "join", playerId: pid(2), name: "B" });
    s = must(s, { type: "start", playerId: pid(1) });
    expect(s.deadline).toBe(T0 + DURATIONS.answer * 0.1);
  });
});

describe("disconnects", () => {
  it("a disconnected player never blocks a phase", () => {
    let s = started(3);
    s = must(s, { type: "disconnect", playerId: pid(3) });
    s = must(s, { type: "answer", playerId: pid(1), value: 3 });
    s = must(s, { type: "answer", playerId: pid(2), value: 5 });
    expect(s.phase).toBe("predict");
  });
  it("a single submission never ends a phase early while others are away", () => {
    let s = started(2);
    s = must(s, { type: "disconnect", playerId: pid(2) });
    s = must(s, { type: "answer", playerId: pid(1), value: 3 });
    expect(s.phase).toBe("answer");
    s = must(s, { type: "connect", playerId: pid(2) });
    s = must(s, { type: "answer", playerId: pid(2), value: 9 });
    expect(s.phase).toBe("predict");
  });
  it("keeps a seat and score through a long mid-game disconnect", () => {
    let s = playRound(started(2), [3, 7], [5, 5]);
    const score = s.players[pid(2)]!.score;
    s = must(s, { type: "disconnect", playerId: pid(2) }, T0 + 1);
    s = must(s, { type: "tick" }, T0 + LOBBY_GRACE_MS * 5);
    expect(s.players[pid(2)]?.score).toBe(score);
    s = must(s, { type: "connect", playerId: pid(2) }, T0 + LOBBY_GRACE_MS * 5);
    expect(s.players[pid(2)]?.connected).toBe(true);
  });
  it("frees lobby seats after the grace period", () => {
    let s = must(lobby(3), { type: "disconnect", playerId: pid(3) }, T0);
    expect(nextWakeTime(s)).toBe(T0 + LOBBY_GRACE_MS);
    s = must(s, { type: "tick" }, T0 + LOBBY_GRACE_MS - 1);
    expect(s.players[pid(3)]).toBeDefined();
    s = must(s, { type: "tick" }, T0 + LOBBY_GRACE_MS);
    expect(s.players[pid(3)]).toBeUndefined();
  });
  it("migrates host after the host grace period to the earliest-seated connected player", () => {
    let s = must(lobby(3), { type: "disconnect", playerId: pid(1) }, T0);
    s = must(s, { type: "tick" }, T0 + HOST_GRACE_MS - 1);
    expect(s.hostId).toBe(pid(1));
    s = must(s, { type: "tick" }, T0 + HOST_GRACE_MS);
    expect(s.hostId).toBe(pid(2));
  });
  it("migrates host immediately when the host leaves", () => {
    const s = must(lobby(3), { type: "leave", playerId: pid(1) });
    expect(s.hostId).toBe(pid(2));
    expect(s.players[pid(1)]).toBeUndefined();
  });
  it("ends the game early when fewer than two players remain", () => {
    const s = must(started(2), { type: "leave", playerId: pid(2) });
    expect(s.phase).toBe("final");
    expect(s.endedEarly).toBe(true);
  });
  it("discards a departed player's unrevealed answer", () => {
    let s = started(3);
    s = must(s, { type: "answer", playerId: pid(3), value: 10 });
    s = must(s, { type: "leave", playerId: pid(3) });
    s = must(s, { type: "answer", playerId: pid(1), value: 2 });
    s = must(s, { type: "answer", playerId: pid(2), value: 4 });
    s = must(s, { type: "predict", playerId: pid(1), value: 3 });
    s = must(s, { type: "predict", playerId: pid(2), value: 3 });
    expect(s.current?.average).toBe(3);
  });
});

describe("late joiners and rematch", () => {
  it("joins mid-game as a spectator who cannot submit, then plays after rematch", () => {
    let s = started(2, 6);
    s = must(s, { type: "join", playerId: pid(5), name: "Late" });
    expect(s.players[pid(5)]?.role).toBe("spectator");
    expect(errorOf(s, { type: "answer", playerId: pid(5), value: 5 })).toBe("not_participant");
    for (let r = 1; r <= 6; r++) {
      s = playAny(s, [4, 6], [5, 5]);
      s = must(s, { type: "next", playerId: pid(1) });
    }
    s = must(s, { type: "play_again", playerId: pid(1) });
    expect(s.players[pid(5)]?.role).toBe("player");
  });
});

describe("abandonment and purity", () => {
  it("flags a room with nobody connected for ABANDON_MS", () => {
    const s = must(lobby(1), { type: "disconnect", playerId: pid(1) }, T0);
    expect(s.emptySince).toBe(T0);
    expect(isAbandoned(s, T0 + ABANDON_MS - 1)).toBe(false);
    expect(isAbandoned(s, T0 + ABANDON_MS)).toBe(true);
    const r = applyAction(s, { type: "connect", playerId: pid(1) }, T0 + 5);
    expect(r.ok && r.state.emptySince).toBeNull();
  });
  it("never mutates the input state", () => {
    const s = started(2);
    const before = JSON.stringify(s);
    applyAction(s, { type: "answer", playerId: pid(1), value: 5 }, T0);
    expect(JSON.stringify(s)).toBe(before);
  });
});

import { applyAction, createRoom, type EngineAction } from "../../shared/engine";
import type { RoomState } from "../../shared/protocol";

export const T0 = 1_700_000_000_000;

/** Deterministic ids that satisfy the protocol's UUID shape. */
export const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function must(s: RoomState, a: EngineAction, now = T0): RoomState {
  const r = applyAction(s, a, now);
  if (!r.ok) throw new Error(`expected ${a.type} to succeed, got ${r.error}`);
  return r.state;
}

export function errorOf(s: RoomState, a: EngineAction, now = T0): string | null {
  const r = applyAction(s, a, now);
  return r.ok ? null : r.error;
}

/** Room with `n` connected players in the lobby; player 1 is host. */
export function lobby(n: number, seed = 42): RoomState {
  let s = createRoom("ABCD", seed, T0);
  for (let i = 1; i <= n; i++) s = must(s, { type: "join", playerId: pid(i), name: `P${i}` });
  return s;
}

export function started(n: number, rounds: 6 | 9 | 12 = 6): RoomState {
  let s = lobby(n);
  s = must(s, { type: "settings", playerId: pid(1), rounds });
  return must(s, { type: "start", playerId: pid(1) });
}

/** Everyone answers then predicts; returns the state at reveal. */
export function playRound(s: RoomState, answers: number[], predictions: number[], now = T0): RoomState {
  answers.forEach((v, i) => (s = must(s, { type: "answer", playerId: pid(i + 1), value: v }, now)));
  predictions.forEach((v, i) => (s = must(s, { type: "predict", playerId: pid(i + 1), value: v }, now)));
  return s;
}

/** Everyone in the current Echo Round makes the first legal pick. */
export function echoAll(s: RoomState, now = T0): RoomState {
  const r = s.current;
  if (s.phase !== "echo" || !r?.echo) throw new Error(`expected echo phase, got ${s.phase}`);
  for (const id of r.participants) {
    let choice = 0;
    if (r.echo.kind === "who" && r.echo.options[0] === id) choice = 1;
    s = must(s, { type: "echo", playerId: id, choice }, now);
  }
  return s;
}

/**
 * Plays the current round to its reveal: regular rounds use the given values
 * (players 1..n), Echo Rounds use echoAll.
 */
export function playAny(s: RoomState, answers: number[], predictions: number[], now = T0): RoomState {
  return s.phase === "echo" ? echoAll(s, now) : playRound(s, answers, predictions, now);
}

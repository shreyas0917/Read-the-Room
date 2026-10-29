import { describe, expect, it } from "vitest";
import { applyAction, isAbandoned, nextWakeTime } from "../../shared/engine";
import type { RoomState } from "../../shared/protocol";
import { ABANDON_MS, HOST_GRACE_MS } from "../../shared/rules";
import { T0, lobby, must, pid, playAny, started } from "./helpers";

// Regression for a production incident: a room whose players had all left
// re-armed its alarm every 50 ms (the host hand-over wake time stayed in the
// past because nobody could take over), writing state ~12,000 times before
// the room expired and exhausting the free plan's daily row-write quota.

/**
 * Simulates the Durable Object alarm loop exactly as worker/room.ts schedules
 * it, and checks the invariant that after every tick the next wake-up is in
 * the future (or there is none). Returns how many alarms fired.
 */
function simulateAlarms(start: RoomState, from: number, until: number): { alarms: number; state: RoomState } {
  let s = start;
  let now = from;
  let alarms = 0;
  for (;;) {
    const wake = nextWakeTime(s);
    if (wake === null || wake > until) break;
    now = Math.max(wake, now + 50);
    if (isAbandoned(s, now)) {
      alarms++; // the DO deletes the room here
      break;
    }
    const r = applyAction(s, { type: "tick" }, now);
    expect(r.ok).toBe(true);
    if (!r.ok) break;
    s = r.state;
    alarms++;
    const next = nextWakeTime(s);
    expect(next === null || next > now, `wake ${next} not after tick at ${now} (phase ${s.phase})`).toBe(true);
    if (alarms > 10_000) throw new Error("alarm loop");
  }
  return { alarms, state: s };
}

function finished(n: number): RoomState {
  let s = started(n, 6);
  for (let r = 1; r <= 6; r++) {
    s = playAny(s, [4, 6, 5, 7].slice(0, n), [5, 5, 5, 5].slice(0, n));
    s = must(s, { type: "next", playerId: pid(1) });
  }
  expect(s.phase).toBe("final");
  return s;
}

describe("alarm scheduling never loops", () => {
  it("everyone leaves the final screen: a couple of alarms, not thousands", () => {
    let s = finished(2);
    s = must(s, { type: "disconnect", playerId: pid(1) }, T0 + 1000);
    s = must(s, { type: "disconnect", playerId: pid(2) }, T0 + 1000);
    const { alarms } = simulateAlarms(s, T0 + 1000, T0 + 1000 + ABANDON_MS + 60_000);
    expect(alarms).toBeLessThanOrEqual(2); // just the abandonment clean-up
  });

  it("everyone leaves mid-game: the game plays out on its timers, then stops", () => {
    let s = started(3, 6);
    for (const i of [1, 2, 3]) s = must(s, { type: "disconnect", playerId: pid(i) }, T0 + 10);
    const { alarms, state } = simulateAlarms(s, T0 + 10, T0 + 30 * 60_000);
    expect(alarms).toBeLessThan(40); // ~2 per round + clean-up
    expect(["final"]).toContain(state.phase);
  });

  it("host gone while only a spectator is connected: no loop", () => {
    let s = started(2, 6);
    s = must(s, { type: "join", playerId: pid(9), name: "Spec" });
    s = must(s, { type: "disconnect", playerId: pid(1) }, T0 + 10);
    s = must(s, { type: "disconnect", playerId: pid(2) }, T0 + 10);
    const { alarms } = simulateAlarms(s, T0 + 10, T0 + 30 * 60_000);
    expect(alarms).toBeLessThan(40);
  });

  it("lobby: a lone host who disconnects is cleaned up without looping", () => {
    let s = lobby(1);
    s = must(s, { type: "disconnect", playerId: pid(1) }, T0);
    const { alarms } = simulateAlarms(s, T0, T0 + ABANDON_MS + 60_000);
    expect(alarms).toBeLessThanOrEqual(3);
  });

  it("host hand-over still happens when someone can take over", () => {
    let s = finished(3);
    s = must(s, { type: "disconnect", playerId: pid(1) }, T0 + 1000);
    expect(nextWakeTime(s)).toBe(T0 + 1000 + HOST_GRACE_MS);
    const { state } = simulateAlarms(s, T0 + 1000, T0 + 1000 + HOST_GRACE_MS);
    expect(state.hostId).toBe(pid(2));
  });

  it("hand-over becomes possible later: a returning player triggers it", () => {
    let s = finished(2);
    s = must(s, { type: "disconnect", playerId: pid(1) }, T0 + 1000);
    s = must(s, { type: "disconnect", playerId: pid(2) }, T0 + 1000);
    const later = T0 + 1000 + HOST_GRACE_MS + 5000;
    s = must(s, { type: "connect", playerId: pid(2) }, later);
    // Host grace has long passed, so the wake is due now; one tick hands over.
    expect(nextWakeTime(s)).toBeLessThanOrEqual(later);
    const r = applyAction(s, { type: "tick" }, later + 50);
    expect(r.ok && r.state.hostId).toBe(pid(2));
  });
});

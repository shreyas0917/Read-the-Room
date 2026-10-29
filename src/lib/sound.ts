// Tiny synthesized sound effects (Web Audio, no files). Quiet by design,
// mutable from the top bar, and the choice is remembered per browser.
// Browsers only allow audio after a user gesture, so the context is created
// lazily and resumed on the first pointer/key press.

import { useSyncExternalStore } from "react";

export type Cue = "lock" | "reveal" | "echo" | "tick" | "win" | "join";

const KEY = "rtr:muted";
let muted = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();
const listeners = new Set<() => void>();
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  ctx ??= new AudioContext();
  return ctx;
}

if (typeof window !== "undefined") {
  const unlock = () => void context()?.resume().catch(() => {});
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
}

/** [frequency Hz, start s, duration s] */
const NOTES: Record<Cue, [number, number, number][]> = {
  lock: [[660, 0, 0.07]],
  join: [[523, 0, 0.08], [784, 0.07, 0.1]],
  tick: [[1046, 0, 0.03]],
  reveal: [[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.2]],
  echo: [[392, 0, 0.14], [587, 0.12, 0.14], [392, 0.26, 0.2]],
  win: [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.12], [1046, 0.36, 0.35]],
};

export function play(cue: Cue): void {
  if (muted) return;
  const ac = context();
  if (!ac || ac.state !== "running") return;
  const t0 = ac.currentTime;
  for (const [freq, start, dur] of NOTES[cue]) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = cue === "tick" ? "square" : "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + start);
    gain.gain.exponentialRampToValueAtTime(cue === "tick" ? 0.03 : 0.08, t0 + start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0 + start);
    osc.stop(t0 + start + dur + 0.02);
  }
}

export function setMuted(next: boolean): void {
  muted = next;
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // ignore
  }
  listeners.forEach((l) => l());
}

export function useMuted(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => muted,
  );
}

import { useCallback, useEffect, useRef, useState } from "react";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** Animates a number toward `target` (ease-out, ~600 ms); instant with reduced motion. */
export function useTween(target: number, ms = 600): number {
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (reduced || from.current === target) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const v = Math.round(a + (target - a) * (1 - (1 - k) ** 3));
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = target;
    };
  }, [target, ms, reduced]);
  return shown;
}

/**
 * Guards a submit button against double taps: after `fire`, `busy` stays true
 * until `resetKey` changes (the server confirmed / the phase moved on) or a
 * short timeout passes (so a rejected send can be retried).
 */
export function useSendOnce(resetKey: unknown, timeoutMs = 2500): [boolean, (fn: () => void) => void] {
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    setBusy(false);
    window.clearTimeout(timer.current);
  }, [resetKey]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const fire = useCallback(
    (fn: () => void) => {
      if (busy) return;
      setBusy(true);
      fn();
      timer.current = window.setTimeout(() => setBusy(false), timeoutMs);
    },
    [busy, timeoutMs],
  );
  return [busy, fire];
}

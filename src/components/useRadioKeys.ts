import { useCallback, useRef, type KeyboardEvent } from "react";

// WAI-ARIA radio group keyboard pattern for a row/grid of role="radio"
// buttons: one Tab stop for the whole group (the selected option, or the
// first enabled one), arrow keys / Home / End move focus *and* selection,
// skipping disabled options. Enter and Space select via the native button
// click, so mouse, touch and keyboard share one code path.

export function useRadioKeys(opts: {
  count: number;
  value: number | null;
  onChange: (index: number) => void;
  isDisabled?: (index: number) => boolean;
}) {
  const { count, value, onChange, isDisabled = () => false } = opts;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const firstEnabled = (() => {
    for (let i = 0; i < count; i++) if (!isDisabled(i)) return i;
    return -1;
  })();
  const tabStop = value !== null && !isDisabled(value) ? value : firstEnabled;

  const move = useCallback(
    (from: number, step: 1 | -1 | "home" | "end") => {
      let i = step === "home" ? -1 : step === "end" ? count : from;
      const dir = step === "home" ? 1 : step === "end" ? -1 : step;
      for (let n = 0; n < count; n++) {
        i = (i + dir + count) % count;
        if (!isDisabled(i)) {
          onChange(i);
          refs.current[i]?.focus();
          return;
        }
      }
    },
    [count, isDisabled, onChange],
  );

  const getProps = (index: number) => ({
    ref: (el: HTMLButtonElement | null) => {
      refs.current[index] = el;
    },
    role: "radio" as const,
    "aria-checked": value === index,
    tabIndex: index === tabStop ? 0 : -1,
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      const key = e.key;
      const step =
        key === "ArrowRight" || key === "ArrowDown"
          ? 1
          : key === "ArrowLeft" || key === "ArrowUp"
            ? -1
            : key === "Home"
              ? "home"
              : key === "End"
                ? "end"
                : null;
      if (step === null) return;
      e.preventDefault();
      move(index, step);
    },
  });

  return { getProps };
}

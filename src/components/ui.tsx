import { useEffect, useState, type ReactNode } from "react";
import type { PlayerView } from "../../shared/protocol";

// --- Avatars -------------------------------------------------------------

const AVATARS = [
  { face: "🦊", bg: "#ff8a5b" },
  { face: "🐼", bg: "#9ad0ff" },
  { face: "🐸", bg: "#7fe0a1" },
  { face: "🦉", bg: "#c6a2ff" },
  { face: "🐙", bg: "#ff8fc7" },
  { face: "🐯", bg: "#ffc75a" },
  { face: "🐨", bg: "#a9b8d6" },
  { face: "🦄", bg: "#f5a8ff" },
  { face: "🐳", bg: "#69d2e7" },
  { face: "🦁", bg: "#f7b267" },
  { face: "🐧", bg: "#b4c5ff" },
  { face: "🐰", bg: "#ffb3c1" },
  { face: "🐻", bg: "#d4a373" },
  { face: "🐝", bg: "#ffe066" },
  { face: "🦖", bg: "#95d5b2" },
  { face: "👾", bg: "#bdb2ff" },
];

export function Avatar({ index, size = 40, dim = false }: { index: number; size?: number; dim?: boolean }) {
  const a = AVATARS[index % AVATARS.length] ?? AVATARS[0]!;
  return (
    <span
      className={`avatar${dim ? " avatar--dim" : ""}`}
      style={{ width: size, height: size, background: a.bg, fontSize: size * 0.55 }}
      aria-hidden="true"
    >
      {a.face}
    </span>
  );
}

export function PlayerChip({ p, you, status }: { p: PlayerView; you: boolean; status?: ReactNode }) {
  return (
    <li className={`chip${p.connected ? "" : " chip--away"}`}>
      <Avatar index={p.avatar} size={36} dim={!p.connected} />
      <span className="chip__name">
        {p.name}
        {you && <span className="chip__you"> (you)</span>}
      </span>
      {p.isHost && (
        <span className="chip__tag" title="Host">
          host
        </span>
      )}
      {!p.connected && <span className="chip__tag chip__tag--muted">away</span>}
      {status}
    </li>
  );
}

// --- Countdown -------------------------------------------------------------

export function useNow(intervalMs = 200): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function Countdown({ deadline, offset, total }: { deadline: number | null; offset: number; total: number }) {
  const now = useNow();
  if (deadline === null) return null;
  const left = Math.max(0, deadline - (now + offset));
  const secs = Math.ceil(left / 1000);
  const frac = total > 0 ? Math.min(1, left / total) : 0;
  return (
    <div className={`timer${secs <= 5 ? " timer--low" : ""}`} role="timer" aria-label={`${secs} seconds left`}>
      <span className="timer__num">{secs}</span>
      <span className="timer__bar">
        <span className="timer__fill" style={{ transform: `scaleX(${frac})` }} />
      </span>
    </div>
  );
}

// --- Rating slider ---------------------------------------------------------

export function RatingSlider(props: {
  value: number;
  onChange: (v: number) => void;
  step: 1 | 0.1;
  low: string;
  high: string;
  label: string;
  disabled?: boolean;
}) {
  const { value, onChange, step, low, high, label, disabled } = props;
  const pct = ((value - 1) / 9) * 100;
  return (
    <div className="slider">
      <div className="slider__value" aria-hidden="true">
        {step === 1 ? value : value.toFixed(1)}
      </div>
      <input
        type="range"
        min={1}
        max={10}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={`${step === 1 ? value : value.toFixed(1)} out of 10`}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ["--pct" as string]: `${pct}%` }}
      />
      <div className="slider__ends">
        <span>1 · {low}</span>
        <span>{high} · 10</span>
      </div>
    </div>
  );
}

// --- Dot plot ------------------------------------------------------------------

/**
 * Anonymous distribution of answers. Dots stack per value; the viewer's own
 * answer is highlighted. The average marker drops in after the dots.
 */
export function DotPlot({ counts, average, yourAnswer }: { counts: number[]; average: number | null; yourAnswer: number | null }) {
  const W = 340;
  const H = 170;
  const padX = 18;
  const base = H - 30;
  const step = (W - padX * 2) / 9;
  const maxStack = Math.max(1, ...counts);
  const r = Math.min(13, (base - 24) / (maxStack * 2.1));
  const x = (v: number) => padX + (v - 1) * step;

  let order = 0;
  const dots: ReactNode[] = [];
  counts.forEach((n, i) => {
    const v = i + 1;
    for (let k = 0; k < n; k++) {
      const mine = yourAnswer === v && k === 0;
      dots.push(
        <circle
          key={`${v}-${k}`}
          className={`dot${mine ? " dot--mine" : ""}`}
          cx={x(v)}
          cy={base - r - k * r * 2.15}
          r={r}
          style={{ animationDelay: `${order++ * 70}ms` }}
        />,
      );
    }
  });

  return (
    <svg className="dotplot" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={describe(counts, average)}>
      <line x1={padX - 8} x2={W - padX + 8} y1={base + 6} y2={base + 6} className="dotplot__axis" />
      {Array.from({ length: 10 }, (_, i) => (
        <text key={i} x={x(i + 1)} y={H - 6} className="dotplot__tick" textAnchor="middle">
          {i + 1}
        </text>
      ))}
      {dots}
      {average !== null && (
        <g className="dotplot__avg" style={{ animationDelay: `${order * 70 + 250}ms` }}>
          <line x1={x(average)} x2={x(average)} y1={10} y2={base + 10} />
          <rect x={x(average) - 26} y={0} width={52} height={20} rx={10} />
          <text x={x(average)} y={14} textAnchor="middle">
            {average.toFixed(1)}
          </text>
        </g>
      )}
    </svg>
  );
}

function describe(counts: number[], average: number | null): string {
  const parts = counts.map((n, i) => (n ? `${n} at ${i + 1}` : "")).filter(Boolean);
  return `Answers: ${parts.join(", ") || "none"}. ${average !== null ? `Average ${average.toFixed(1)}.` : ""}`;
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  kind?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  big?: boolean;
}) {
  const { children, onClick, kind = "primary", disabled, type = "button", big } = props;
  return (
    <button type={type} className={`btn btn--${kind}${big ? " btn--big" : ""}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

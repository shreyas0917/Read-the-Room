import { useEffect, useState, type ReactNode } from "react";
import type { ClientView, EchoView, PlayerView } from "../../shared/protocol";
import { Avatar, Button, DotPlot } from "../components/ui";
import { useRadioKeys } from "../components/useRadioKeys";
import { RoundHeader, Spectating, SubmittedStrip, useExpired, type Props } from "./Game";
import { useSendOnce } from "../lib/hooks";
import { MODE_NAME } from "../lib/reportText";

const METRIC_TEXT = {
  highest: "had the highest average?",
  lowest: "had the lowest average?",
  split: "split the room the most?",
} as const;


function Quote({ text }: { text: string }) {
  return <span className="quote">“{text}”</span>;
}

/** The question, phrased from structured data so the server never sends prose. */
function Question({ echo }: { echo: EchoView }) {
  switch (echo.kind) {
    case "count":
      return (
        <>
          <p className="eyebrow eyebrow--muted">Back in round {echo.sourceRound}</p>
          <p className="echo-q__src">
            <Quote text={echo.prompt?.text ?? ""} />
          </p>
          <h1 className="echo-q__ask" id="echo-ask">
            How many of the {echo.max} answers were <b>higher than {echo.threshold}</b>?
          </h1>
        </>
      );
    case "pattern":
      return <h1 className="echo-q__ask" id="echo-ask">Which question {METRIC_TEXT[echo.metric ?? "highest"]}</h1>;
    case "who":
      return (
        <>
          <p className="eyebrow eyebrow--muted">Back in round {echo.sourceRound}</p>
          <p className="echo-q__src">
            <Quote text={echo.prompt?.text ?? ""} />
          </p>
          <h1 className="echo-q__ask" id="echo-ask">
            Someone answered <b>{echo.value}</b>. Who was it?
          </h1>
        </>
      );
  }
}

function EchoIntro() {
  return (
    <section className="card echo-intro" aria-label="About Echo Rounds">
      <p className="echo-intro__title">
        <span aria-hidden="true">⟲</span> Echo Round
      </p>
      <p className="small">
        Every third round asks about what <b>this room already answered</b>. No new question, just how well you remember
        the dots.
      </p>
    </section>
  );
}

function optionLabel(echo: EchoView, choice: number, byId: Map<string, PlayerView>): string {
  if (echo.kind === "count") return String(choice);
  if (echo.kind === "pattern") return echo.promptOptions?.[choice]?.text ?? "?";
  return byId.get(echo.playerOptions?.[choice] ?? "")?.name ?? "?";
}

// --- ECHO --------------------------------------------------------------------------

export function EchoScreen(props: Props) {
  const { view, send, offset } = props;
  const echo = view.echo;
  const [pick, setPick] = useState<number | null>(null);
  useEffect(() => setPick(null), [view.round]);
  const [busy, fire] = useSendOnce(`${view.round}:${view.mine.echo}`);
  const expired = useExpired(view.deadline, offset);
  if (!echo) return null;
  const byId = new Map(view.players.map((p) => [p.id, p]));
  const locked = view.mine.echo;
  const youId = view.you?.id;

  let options: Option[] = [];
  if (echo.kind === "count") {
    options = Array.from({ length: (echo.max ?? 0) + 1 }, (_, i) => ({
      value: i,
      label: String(i),
      node: <span className="opt-num">{i}</span>,
    }));
  } else if (echo.kind === "pattern") {
    options = (echo.promptOptions ?? []).map((p, i) => ({
      value: i,
      label: p.text,
      node: <span className="opt-text">{p.text}</span>,
    }));
  } else {
    options = (echo.playerOptions ?? []).map((id, i) => {
      const p = byId.get(id);
      return {
        value: i,
        disabled: id === youId,
        label: id === youId ? `${p?.name ?? "?"} (you, not selectable)` : (p?.name ?? "?"),
        node: (
          <span className="opt-player">
            {p && <Avatar index={p.avatar} size={36} />}
            <span>{p?.name ?? "?"}</span>
            {id === youId && <span className="muted small">(you)</span>}
          </span>
        ),
      };
    });
  }

  return (
    <main className="screen game">
      <RoundHeader {...props} label={MODE_NAME[echo.kind]} />
      {echo.first && <EchoIntro />}
      <section className="card echo-q" aria-live="polite">
        <Question echo={echo} />
      </section>

      {echo.youAreSubject && locked === null && (
        <p className="subject" role="status">
          <b>Shh, it was you.</b> Make a decoy pick to throw them off. You get +25 for every wrong guess.
        </p>
      )}

      {!view.you?.participant ? (
        <Spectating />
      ) : locked !== null ? (
        <section className="card locked">
          <p className="locked__label">{optionLabel(echo, locked, byId)}</p>
          <p className="muted">Locked in.</p>
        </section>
      ) : (
        <section className="card">
          <EchoOptions kind={echo.kind} options={options} pick={pick} onPick={setPick} />
          <Button
            big
            disabled={pick === null || busy || expired}
            onClick={() => pick !== null && fire(() => send({ t: "echo", choice: pick }))}
          >
            {expired ? "Time's up" : pick === null ? "Pick one" : busy ? "Locking in…" : "Lock it in"}
          </Button>
        </section>
      )}
      <SubmittedStrip view={view} />
    </main>
  );
}

interface Option {
  value: number;
  node: ReactNode;
  label: string;
  disabled?: boolean;
}

function EchoOptions({ kind, options, pick, onPick }: { kind: EchoView["kind"]; options: Option[]; pick: number | null; onPick: (v: number) => void }) {
  const { getProps } = useRadioKeys({
    count: options.length,
    value: pick,
    onChange: onPick,
    isDisabled: (i) => !!options[i]?.disabled,
  });
  return (
    <div className={`options options--${kind}`} role="radiogroup" aria-labelledby="echo-ask">
      {options.map((o, i) => (
        <button
          key={o.value}
          {...getProps(i)}
          aria-label={o.label}
          disabled={o.disabled}
          className={`option${pick === o.value ? " is-on" : ""}`}
          onClick={() => onPick(o.value)}
        >
          {o.node}
          {pick === o.value && (
            <span className="option__check" aria-hidden="true">
              ✓
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// --- ECHO REVEAL ---------------------------------------------------------------------

function Answer({ view, byId }: { view: ClientView; byId: Map<string, PlayerView> }) {
  const echo = view.echo!;
  const res = echo.result!;
  if (res.cancelled) return <p className="notice">The person who said it left the room, so this round doesn't count.</p>;

  if (echo.kind === "count") {
    return (
      <>
        <p className="reveal__title">
          The answer: <b>{res.truth}</b>
        </p>
        {res.counts && <DotPlot counts={res.counts} average={null} yourAnswer={null} highlightAbove={echo.threshold} />}
        <p className="muted small center">Highlighted: answers higher than {echo.threshold}.</p>
      </>
    );
  }
  if (echo.kind === "pattern") {
    return (
      <ol className="pattern">
        {(echo.promptOptions ?? []).map((p, i) => {
          const st = res.stats?.[i];
          return (
            <li key={p.id} className={i === res.truth ? "is-win" : ""}>
              <p className="pattern__q">{p.text}</p>
              {st && <DotPlot counts={st.counts} average={st.average} yourAnswer={null} compact />}
              <p className="pattern__stats small">
                average <b>{st?.average.toFixed(1)}</b> · spread <b>{st?.spread.toFixed(1)}</b>
              </p>
            </li>
          );
        })}
      </ol>
    );
  }
  const subject = res.subjectId ? byId.get(res.subjectId) : undefined;
  return (
    <div className="who-reveal">
      {subject && <Avatar index={subject.avatar} size={72} />}
      <p className="reveal__title">
        It was <b>{subject?.name ?? "?"}</b>
      </p>
      <p className="muted small">
        They answered {echo.value} to <Quote text={echo.prompt?.text ?? ""} />
      </p>
    </div>
  );
}

export function EchoRevealScreen(props: Props) {
  const { view, send } = props;
  const echo = view.echo;
  const res = echo?.result;
  if (!echo || !res) return null;
  const byId = new Map(view.players.map((p) => [p.id, p]));
  const rows = res.picks
    .map((pk) => ({ ...pk, player: byId.get(pk.playerId) }))
    .filter((r): r is typeof r & { player: PlayerView } => !!r.player)
    .sort((a, b) => b.score.total - a.score.total);
  const last = view.round >= view.totalRounds;
  const fooled = res.picks.filter((p) => p.playerId !== res.subjectId && p.choice !== null && p.choice !== res.truth).length;

  return (
    <main className="screen game">
      <RoundHeader {...props} label={MODE_NAME[echo.kind]} />
      <section className="card echo-q">
        <Question echo={echo} />
      </section>
      <section className="card reveal">
        <Answer view={view} byId={byId} />
      </section>
      {!res.cancelled && (
        <section className="card">
          <ol className="scores">
            {rows.map((r) => {
              const isSubject = r.playerId === res.subjectId;
              return (
                <li key={r.playerId} className={r.playerId === view.you?.id ? "is-you" : ""}>
                  <Avatar index={r.player.avatar} size={32} />
                  <span className="scores__name">{r.player.name}</span>
                  <span className="scores__guess">
                    {isSubject
                      ? `fooled ${fooled} ${fooled === 1 ? "player" : "players"}`
                      : r.choice === null
                        ? "no pick"
                        : `picked ${optionLabel(echo, r.choice, byId)}`}
                  </span>
                  <span className="scores__pts">
                    +{r.score.total}
                    {!isSubject && r.choice === res.truth && <em className="badge badge--lime">right</em>}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {view.you?.isHost ? (
        <Button big onClick={() => send({ t: "next" })}>
          {last ? "See final results" : "Next round"}
        </Button>
      ) : (
        <p className="muted small center">Next round starts automatically.</p>
      )}
    </main>
  );
}

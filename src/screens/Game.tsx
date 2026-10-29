import { useEffect, useState } from "react";
import type { ClientMessage, ClientView, PlayerView } from "../../shared/protocol";
import { DURATIONS } from "../../shared/rules";
import { Avatar, Button, Countdown, DotPlot, RatingSlider } from "../components/ui";

interface Props {
  view: ClientView;
  send: (m: ClientMessage) => void;
  offset: number;
}

function RoundHeader({ view, offset, label }: Props & { label: string }) {
  const total = view.phase === "answer" ? DURATIONS.answer : view.phase === "predict" ? DURATIONS.predict : DURATIONS.reveal;
  return (
    <header className="round-head">
      <div>
        <p className="eyebrow">
          Round {view.round} of {view.totalRounds}
        </p>
        <p className="phase-label">{label}</p>
      </div>
      <Countdown deadline={view.deadline} offset={offset} total={total} />
    </header>
  );
}

function SubmittedStrip({ view }: { view: ClientView }) {
  const ps = view.players.filter((p) => p.submitted !== null);
  return (
    <div className="strip" aria-label={`${view.submittedCount} of ${view.expectedCount} locked in`}>
      <ul>
        {ps.map((p) => (
          <li key={p.id} className={p.submitted ? "is-in" : ""} title={`${p.name}${p.submitted ? " — locked in" : ""}`}>
            <Avatar index={p.avatar} size={30} dim={!p.connected} />
          </li>
        ))}
      </ul>
      <span className="muted small">
        {view.submittedCount}/{view.expectedCount} locked in
      </span>
    </div>
  );
}

function PromptCard({ view }: { view: ClientView }) {
  if (!view.prompt) return null;
  return (
    <section className="card prompt" aria-live="polite">
      <h1 className="prompt__text">{view.prompt.text}</h1>
    </section>
  );
}

function Spectating() {
  return <p className="notice">You joined mid-game, so you're spectating. You'll play in the next game.</p>;
}

// --- ANSWER --------------------------------------------------------------------

export function AnswerScreen(props: Props) {
  const { view, send } = props;
  const [value, setValue] = useState(5);
  const locked = view.mine.answer;
  useEffect(() => setValue(5), [view.round]);

  return (
    <main className="screen game">
      <RoundHeader {...props} label="Answer honestly" />
      <PromptCard view={view} />
      {!view.you?.participant ? (
        <Spectating />
      ) : locked !== null ? (
        <section className="card locked">
          <p className="locked__big">{locked}</p>
          <p className="muted">Locked in. Nobody else can see this.</p>
        </section>
      ) : (
        <section className="card">
          <RatingSlider
            value={value}
            onChange={setValue}
            step={1}
            low={view.prompt?.low ?? ""}
            high={view.prompt?.high ?? ""}
            label="Your answer"
          />
          <Button big onClick={() => send({ t: "answer", value })}>
            Lock in {value}
          </Button>
          <p className="muted small center">Secret &amp; anonymous.</p>
        </section>
      )}
      <SubmittedStrip view={view} />
    </main>
  );
}

// --- PREDICT -------------------------------------------------------------------

export function PredictScreen(props: Props) {
  const { view, send } = props;
  const [value, setValue] = useState(() => view.mine.answer ?? 5.5);
  const locked = view.mine.prediction;
  useEffect(() => setValue(view.mine.answer ?? 5.5), [view.round, view.mine.answer]);

  return (
    <main className="screen game">
      <RoundHeader {...props} label="Read the room" />
      <PromptCard view={view} />
      {!view.you?.participant ? (
        <Spectating />
      ) : locked !== null ? (
        <section className="card locked">
          <p className="locked__big">{locked.toFixed(1)}</p>
          <p className="muted">Your prediction for the room's average.</p>
        </section>
      ) : (
        <section className="card">
          <p className="ask">What's the room's average?</p>
          <RatingSlider
            value={value}
            onChange={(v) => setValue(Math.round(v * 10) / 10)}
            step={0.1}
            low={view.prompt?.low ?? ""}
            high={view.prompt?.high ?? ""}
            label="Predicted average"
          />
          <Button big onClick={() => send({ t: "predict", value })}>
            Predict {value.toFixed(1)}
          </Button>
          {view.mine.answer !== null && <p className="muted small center">You answered {view.mine.answer}.</p>}
        </section>
      )}
      <SubmittedStrip view={view} />
    </main>
  );
}

// --- REVEAL --------------------------------------------------------------------

export function RevealScreen(props: Props) {
  const { view, send } = props;
  const rv = view.reveal;
  if (!rv) return null;
  const byId = new Map(view.players.map((p) => [p.id, p]));
  const rows = rv.predictions
    .map((pr) => ({ ...pr, player: byId.get(pr.playerId) }))
    .filter((r): r is typeof r & { player: PlayerView } => !!r.player)
    .sort((a, b) => b.score.total - a.score.total);
  const wildcard = rv.wildcardId ? byId.get(rv.wildcardId) : undefined;
  const last = view.round >= view.totalRounds;

  return (
    <main className="screen game">
      <RoundHeader {...props} label="The reveal" />
      <PromptCard view={view} />
      <section className="card reveal">
        {rv.voided ? (
          <p className="notice">Not enough answers this round, so it doesn't count.</p>
        ) : (
          <>
            <p className="reveal__title">
              The room said <b>{rv.average?.toFixed(1)}</b>
            </p>
            <DotPlot counts={rv.counts} average={rv.average} yourAnswer={rv.yourAnswer} />
            {wildcard && (
              <p className="wildcard">
                <Avatar index={wildcard.avatar} size={28} /> <b>{wildcard.name}</b> is the Wildcard (+25)
              </p>
            )}
          </>
        )}
      </section>

      {!rv.voided && (
        <section className="card">
          <ol className="scores">
            {rows.map((r) => (
              <li key={r.playerId} className={r.playerId === view.you?.id ? "is-you" : ""}>
                <Avatar index={r.player.avatar} size={32} />
                <span className="scores__name">{r.player.name}</span>
                <span className="scores__guess">{r.value === null ? "no guess" : `guessed ${r.value.toFixed(1)}`}</span>
                <span className="scores__pts">
                  +{r.score.total}
                  {r.score.bullseye > 0 && <em className="badge">bullseye</em>}
                </span>
              </li>
            ))}
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

// --- FINAL ---------------------------------------------------------------------

export function FinalScreen({ view, send }: Props) {
  const byId = new Map(view.players.map((p) => [p.id, p]));
  const standings = view.standings ?? [];
  const winners = standings.filter((s) => s.rank === 1).map((s) => byId.get(s.playerId)?.name ?? "?");

  return (
    <main className="screen final">
      <header className="final__head">
        <p className="eyebrow">{view.endedEarly ? "Game ended early" : "Final results"}</p>
        <h1 className="final__winner">{winners.length > 1 ? `${winners.join(" & ")} tie!` : `${winners[0] ?? "Nobody"} wins!`}</h1>
      </header>

      <section className="card">
        <ol className="standings">
          {standings.map((s) => {
            const p = byId.get(s.playerId);
            if (!p) return null;
            return (
              <li key={s.playerId} className={`${s.rank === 1 ? "is-first" : ""}${p.id === view.you?.id ? " is-you" : ""}`}>
                <span className="standings__rank">{s.rank}</span>
                <Avatar index={p.avatar} size={40} />
                <span className="standings__name">{p.name}</span>
                <span className="standings__meta muted small">
                  {s.bullseyes} bullseye{s.bullseyes === 1 ? "" : "s"}
                </span>
                <span className="standings__score">{s.score}</span>
              </li>
            );
          })}
        </ol>
      </section>

      {view.rounds && view.rounds.length > 0 && (
        <section className="card">
          <h2 className="h2">How the room answered</h2>
          <ul className="recap">
            {view.rounds.map((r) => (
              <li key={r.index}>
                <span className="recap__q">{r.prompt.text}</span>
                <span className="recap__avg">{r.voided || r.average === null ? "—" : r.average.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.you?.isHost ? (
        <Button big onClick={() => send({ t: "play_again" })}>
          Play again with this room
        </Button>
      ) : (
        <p className="muted small center">Waiting for the host to start a rematch…</p>
      )}
    </main>
  );
}

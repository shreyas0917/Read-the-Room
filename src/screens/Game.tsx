import { useEffect, useState } from "react";
import type { ClientMessage, ClientView, PlayerView } from "../../shared/protocol";
import { DURATIONS } from "../../shared/rules";
import { Avatar, Button, Countdown, DotPlot, RatingSlider, useNow } from "../components/ui";
import { useSendOnce } from "../lib/hooks";

export interface Props {
  view: ClientView;
  send: (m: ClientMessage) => void;
  offset: number;
}

const PHASE_TOTAL: Partial<Record<ClientView["phase"], number>> = {
  answer: DURATIONS.answer,
  predict: DURATIONS.predict,
  reveal: DURATIONS.reveal,
  echo: DURATIONS.echo,
  echo_reveal: DURATIONS.echoReveal,
};

export function RoundHeader({ view, offset, label }: Props & { label: string }) {
  const total = PHASE_TOTAL[view.phase] ?? DURATIONS.reveal;
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

/** True once the server deadline has passed (by the server's clock). */
export function useExpired(deadline: number | null, offset: number): boolean {
  const now = useNow(250);
  return deadline !== null && now + offset >= deadline;
}

export function SubmittedStrip({ view }: { view: ClientView }) {
  const ps = view.players.filter((p) => p.submitted !== null);
  const done = ps.filter((p) => p.submitted).map((p) => p.name);
  // Once you're locked in, say who the room is waiting on.
  const youDone = ps.some((p) => p.id === view.you?.id && p.submitted);
  const waitingFor = youDone ? ps.filter((p) => !p.submitted).map((p) => (p.connected ? p.name : `${p.name} (away)`)) : [];
  const label = `${view.submittedCount} of ${view.expectedCount} locked in${done.length ? `: ${done.join(", ")}` : ""}`;
  return (
    <div className="strip" role="status" aria-label={label}>
      <ul aria-hidden="true">
        {ps.map((p) => (
          <li key={p.id} className={p.submitted ? "is-in" : ""} title={`${p.name}${p.submitted ? ": locked in" : ""}`}>
            <Avatar index={p.avatar} size={30} dim={!p.connected} />
            {p.submitted && <span className="strip__tick">✓</span>}
          </li>
        ))}
      </ul>
      <span className="muted small">
        {view.submittedCount}/{view.expectedCount} locked in
      </span>
      {waitingFor.length > 0 && <p className="strip__waiting small">Waiting for {waitingFor.join(", ")}</p>}
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

export function Spectating() {
  return <p className="notice">You joined mid-game, so you're spectating. You'll play in the next game.</p>;
}

// --- ANSWER --------------------------------------------------------------------

export function AnswerScreen(props: Props) {
  const { view, send, offset } = props;
  const [value, setValue] = useState(5);
  const locked = view.mine.answer;
  useEffect(() => setValue(5), [view.round]);
  const [busy, fire] = useSendOnce(`${view.round}:${locked}`);
  const expired = useExpired(view.deadline, offset);

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
          <Button big disabled={busy || expired} onClick={() => fire(() => send({ t: "answer", value }))}>
            {expired ? "Time's up" : busy ? "Locking in…" : `Lock in ${value}`}
          </Button>
          {view.you?.onRecord ? (
            <p className="onrecord small">
              <b>On the record.</b> You opted in, so this answer could be shown with your name in a "Who said it?" round.
            </p>
          ) : (
            <p className="muted small center">Secret &amp; anonymous.</p>
          )}
        </section>
      )}
      <SubmittedStrip view={view} />
    </main>
  );
}

// --- PREDICT -------------------------------------------------------------------

export function PredictScreen(props: Props) {
  const { view, send, offset } = props;
  const [value, setValue] = useState(() => view.mine.answer ?? 5.5);
  const locked = view.mine.prediction;
  useEffect(() => setValue(view.mine.answer ?? 5.5), [view.round, view.mine.answer]);
  const [busy, fire] = useSendOnce(`${view.round}:${locked}`);
  const expired = useExpired(view.deadline, offset);

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
          <Button big disabled={busy || expired} onClick={() => fire(() => send({ t: "predict", value }))}>
            {expired ? "Time's up" : busy ? "Locking in…" : `Predict ${value.toFixed(1)}`}
          </Button>
          {view.mine.answer !== null ? (
            <p className="muted small center">You answered {view.mine.answer}.</p>
          ) : (
            <p className="muted small center">You missed the answer, but you can still predict.</p>
          )}
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
  const rows = rv.guesses
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
            <p className="muted small center">
              {rv.answerCount} anonymous answers
              {rv.yourAnswer !== null ? " · yours is the ringed lime dot" : view.you?.participant ? " · you didn't answer in time" : ""}
            </p>
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
          {view.round === 1 && (
            <p className="score-key small">
              Closer guess = more points (up to 100) · within 0.3 = <b>+50 Bullseye</b> · lone extreme answer ={" "}
              <b>+25 Wildcard</b>
            </p>
          )}
          <ol className="scores">
            {rows.map((r) => (
              <li key={r.playerId} className={r.playerId === view.you?.id ? "is-you" : ""}>
                <Avatar index={r.player.avatar} size={32} />
                <span className="scores__name">{r.player.name}</span>
                <span className="scores__guess">{r.value === null ? "no guess" : `guessed ${r.value.toFixed(1)}`}</span>
                <span className="scores__pts">
                  <span className="pop">+{r.score.total}</span>
                  {r.score.bullseye > 0 && <em className="badge">bullseye</em>}
                  {r.score.wildcard > 0 && <em className="badge badge--lime">wildcard</em>}
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

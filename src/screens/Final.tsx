import { useMemo, useState } from "react";
import type { EchoRoundReport, PlayerView, RegularRoundReport, Standing } from "../../shared/protocol";
import { Avatar, Button } from "../components/ui";
import { useTween } from "../lib/hooks";
import { AWARD_META, echoAnswer, echoQuestion, joinNames, MODE_NAME, momentText, reportText } from "../lib/reportText";
import type { Props } from "./Game";

function Score({ value }: { value: number }) {
  return <>{useTween(value, 900)}</>;
}

function MiniBars({ counts }: { counts: number[] }) {
  const max = Math.max(1, ...counts);
  return (
    <svg className="minibars" viewBox="0 0 100 24" aria-hidden="true" preserveAspectRatio="none">
      {counts.map((n, i) => (
        <rect key={i} x={i * 10 + 1} width={8} y={24 - (n / max) * 22} height={(n / max) * 22} rx={2} />
      ))}
    </svg>
  );
}

function RegularRow({ r, name }: { r: RegularRoundReport; name: (id: string) => string }) {
  return (
    <li className="recap-row">
      <span className="recap-row__n">R{r.index}</span>
      <div className="recap-row__body">
        <p className="recap-row__q">{r.prompt.text}</p>
        {r.voided || r.average === null ? (
          <p className="recap-row__meta">Not enough answers, so it didn't count</p>
        ) : (
          <p className="recap-row__meta">
            Room said <b>{r.average.toFixed(1)}</b>
            {r.closest && <> · closest: {joinNames(r.closest.playerIds, name)}</>}
            {r.bullseyes > 0 && <> · {r.bullseyes} 🎯</>}
          </p>
        )}
      </div>
      {!r.voided && <MiniBars counts={r.counts} />}
    </li>
  );
}

function EchoRow({ r, name }: { r: EchoRoundReport; name: (id: string) => string }) {
  return (
    <li className="recap-row recap-row--echo">
      <span className="recap-row__n">R{r.index}</span>
      <div className="recap-row__body">
        <p className="recap-row__q">
          <span className="tag">⟲ {MODE_NAME[r.mode]}</span> {echoQuestion(r)}
        </p>
        <p className="recap-row__meta">
          {r.cancelled ? (
            "Cancelled: the person who said it left"
          ) : (
            <>
              <b>{echoAnswer(r, name)}</b> · {r.correct} of {r.guessers} got it
            </>
          )}
        </p>
      </div>
    </li>
  );
}

function Podium({ standings, byId, youId }: { standings: Standing[]; byId: Map<string, PlayerView>; youId?: string }) {
  return (
    <ol className="standings">
      {standings.map((s) => {
        const p = byId.get(s.playerId);
        if (!p) return null;
        return (
          <li key={s.playerId} className={`${s.rank === 1 ? "is-first" : ""}${p.id === youId ? " is-you" : ""}`}>
            <span className="standings__rank" aria-label={`Rank ${s.rank}`}>
              {s.rank === 1 ? "🏆" : s.rank}
            </span>
            <Avatar index={p.avatar} size={40} />
            <span className="standings__name">
              {p.name}
              {p.id === youId && <span className="chip__you"> (you)</span>}
            </span>
            <span className="standings__meta muted small">
              {s.bullseyes} 🎯
            </span>
            <span className="standings__score">
              <Score value={s.score} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function FinalScreen({ view, send }: Props) {
  const byId = useMemo(() => new Map(view.players.map((p) => [p.id, p])), [view.players]);
  const name = (id: string) => byId.get(id)?.name ?? "someone";
  const standings = view.standings ?? [];
  const report = view.report;
  const winners = standings.filter((s) => s.rank === 1).map((s) => name(s.playerId));
  const text = useMemo(
    () => (report ? reportText(report, standings, view.players, location.origin) : ""),
    [report, standings, view.players],
  );
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const you = report?.players.find((p) => p.playerId === view.you?.id);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    window.setTimeout(() => setCopied(null), 2000);
  }
  async function share() {
    try {
      await navigator.share({ title: "Read the Room: Room Report", text });
    } catch {
      // cancelled
    }
  }

  return (
    <main className="screen final">
      <header className="final__head">
        <p className="eyebrow">{view.endedEarly ? "Game ended early" : "Final results"}</p>
        <h1 className="final__winner">{winners.length > 1 ? `${winners.join(" & ")} tie!` : `${winners[0] ?? "Nobody"} wins!`}</h1>
      </header>

      <section className="card" aria-label="Final standings">
        <Podium standings={standings} byId={byId} youId={view.you?.id} />
      </section>

      {report && report.awards.length > 0 && (
        <section className="awards" aria-label="Awards">
          {report.awards.map((a) => {
            const meta = AWARD_META[a.id];
            return (
              <article key={a.id} className="award">
                <span className="award__icon" aria-hidden="true">
                  {meta.icon}
                </span>
                <div>
                  <p className="award__title">{meta.title}</p>
                  <p className="award__who">{joinNames(a.winners, name)}</p>
                  <p className="award__why small muted">{meta.describe(a.value)}</p>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {you && (
        <section className="card you-stats" aria-label="Your game">
          <h2 className="h2">Your game</h2>
          <dl className="stats">
            <div>
              <dt>Avg. prediction error</dt>
              <dd>{you.avgError === null ? "—" : you.avgError.toFixed(2)}</dd>
            </div>
            <div>
              <dt>Bullseyes</dt>
              <dd>{you.bullseyes}</dd>
            </div>
            <div>
              <dt>Echo Rounds right</dt>
              <dd>{you.echoPlayed ? `${you.echoCorrect}/${you.echoPlayed}` : "—"}</dd>
            </div>
          </dl>
        </section>
      )}

      {report && (
        <section className="card report" aria-labelledby="report-h">
          <div className="row-between">
            <h2 className="h2" id="report-h">
              Room Report
            </h2>
            <span className="muted small">
              {report.playedRounds}/{report.totalRounds} rounds
            </span>
          </div>

          {report.moments.length > 0 && (
            <ul className="moments">
              {report.moments.map((m) => {
                const t = momentText(m, name);
                return (
                  <li key={m.kind}>
                    <b>{t.title}</b> {t.body}
                  </li>
                );
              })}
            </ul>
          )}

          <ol className="recap-list" aria-label="Round by round">
            {report.rounds.map((r) =>
              r.kind === "regular" ? <RegularRow key={r.index} r={r} name={name} /> : <EchoRow key={r.index} r={r} name={name} />,
            )}
          </ol>

          <div className="report__actions">
            <Button kind="ghost" onClick={copy}>
              {copied === "copied" ? "Copied!" : copied === "failed" ? "Couldn't copy" : "Copy report"}
            </Button>
            {"share" in navigator && (
              <Button kind="ghost" onClick={share}>
                Share…
              </Button>
            )}
          </div>
          <p className="muted small">Includes names, scores and round results. Never anyone's answers.</p>
          <details className="report__preview">
            <summary>Preview the text</summary>
            <pre>{text}</pre>
          </details>
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


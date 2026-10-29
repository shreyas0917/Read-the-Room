import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { ClientMessage, ClientView } from "../../shared/protocol";
import { ROUND_OPTIONS, MIN_PLAYERS, MAX_PLAYERS } from "../../shared/rules";
import { Button, PlayerChip } from "../components/ui";

export function Lobby({ view, send }: { view: ClientView; send: (m: ClientMessage) => void }) {
  const link = `${location.origin}/r/${view.code}`;
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isHost = !!view.you?.isHost;
  const seated = view.players.filter((p) => p.role === "player");
  const ready = seated.filter((p) => p.connected).length;

  useEffect(() => {
    let live = true;
    QRCode.toString(link, { type: "svg", margin: 0, color: { dark: "#0f0820", light: "#00000000" } })
      .then((svg) => live && setQr(svg))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [link]);

  async function share() {
    try {
      if (navigator.share) await navigator.share({ title: "Read the Room", text: `Join my room: ${view.code}`, url: link });
      else {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      }
    } catch {
      // user cancelled share sheet
    }
  }

  return (
    <main className="screen lobby">
      <section className="card room-code">
        <p className="eyebrow">Room code</p>
        <p className="room-code__code" aria-label={`Room code ${view.code.split("").join(" ")}`}>
          {view.code}
        </p>
        <div className="room-code__share">
          {qr && <div className="qr" aria-hidden="true" dangerouslySetInnerHTML={{ __html: qr }} />}
          <div className="room-code__actions">
            <p className="muted small">Scan or share this link — no app, no login.</p>
            <Button kind="ghost" onClick={share}>
              {copied ? "Link copied" : "Share invite link"}
            </Button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="row-between">
          <h2 className="h2">Players</h2>
          <span className="muted small">
            {seated.length}/{MAX_PLAYERS}
          </span>
        </div>
        <ul className="chips">
          {view.players.map((p) => (
            <PlayerChip key={p.id} p={p} you={p.id === view.you?.id} />
          ))}
        </ul>
        {seated.length < MIN_PLAYERS && <p className="muted small">Waiting for at least one more player…</p>}
      </section>

      <Rules />

      <section className="card host-panel">
        {isHost ? (
          <>
            <div className="field">
              <span className="field__label">Rounds</span>
              <div className="segmented" role="radiogroup" aria-label="Number of rounds">
                {ROUND_OPTIONS.map((n) => (
                  <button
                    key={n}
                    role="radio"
                    aria-checked={view.settings.rounds === n}
                    className={view.settings.rounds === n ? "is-on" : ""}
                    onClick={() => send({ t: "settings", rounds: n })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <Button big disabled={ready < MIN_PLAYERS} onClick={() => send({ t: "start" })}>
              {ready < MIN_PLAYERS ? "Need 2 players to start" : `Start game · ${ready} players`}
            </Button>
          </>
        ) : (
          <p className="waiting">
            Waiting for <b>{view.players.find((p) => p.isHost)?.name ?? "the host"}</b> to start · {view.settings.rounds} rounds
          </p>
        )}
      </section>
    </main>
  );
}

export function Rules() {
  return (
    <section className="card rules" aria-labelledby="rules-h">
      <h2 className="h2" id="rules-h">
        How to play
      </h2>
      <ol className="rules__list">
        <li>
          <span className="rules__n">1</span>
          <div>
            <b>Answer in secret.</b> Rate the question from 1 to 10. Answers are anonymous — the reveal shows dots, not
            names.
          </div>
        </li>
        <li>
          <span className="rules__n">2</span>
          <div>
            <b>Predict the room.</b> Guess the average of everyone's answers, yours included.
          </div>
        </li>
        <li>
          <span className="rules__n">3</span>
          <div>
            <b>Score.</b> Up to 100 points for a close guess, <b>+50 Bullseye</b> within 0.3. The one answer furthest
            from the average (by 2+) is named the <b>Wildcard</b> and earns +25.
          </div>
        </li>
      </ol>
    </section>
  );
}

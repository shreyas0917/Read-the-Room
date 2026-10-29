import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ClientView } from "../../shared/protocol";
import { useRoom } from "../net/useRoom";
import { useTween } from "../lib/hooks";
import { MODE_NAME } from "../lib/reportText";
import { play, setMuted, useMuted } from "../lib/sound";
import { loadName, peekPendingJoin, saveName } from "../lib/storage";
import { navigate } from "../router";
import { Button } from "../components/ui";
import { Lobby } from "./Lobby";
import { AnswerScreen, PredictScreen, RevealScreen } from "./Game";
import { FinalScreen } from "./Final";
import { EchoRevealScreen, EchoScreen } from "./Echo";

export function RoomScreen({ code }: { code: string }) {
  const [initialName] = useState(() => peekPendingJoin(code));
  const room = useRoom(code, initialName);
  const { status, view, needsName } = room;
  useGameCues(view, room.clockOffset);
  const online = useOnline();

  if (status === "not_found") {
    return (
      <Centered title="Room not found">
        <p className="muted">
          There's no active room <b>{code}</b>. It may have closed after everyone left.
        </p>
        <Button onClick={() => navigate("/")}>Back to start</Button>
      </Centered>
    );
  }
  if (status === "closed") {
    return (
      <Centered title="You left the room">
        <Button onClick={() => navigate("/")}>Back to start</Button>
      </Centered>
    );
  }
  if (status === "replaced") {
    return (
      <Centered title="Open in another tab">
        <p className="muted">This seat is now being used in another window or device.</p>
        <Button onClick={() => location.reload()}>Use it here instead</Button>
      </Centered>
    );
  }

  let body;
  if (needsName && !view) body = <JoinForm code={code} onJoin={room.join} busy={room.joining} error={room.nameError} />;
  else if (!view) body = <Centered title={status === "reconnecting" ? "Reconnecting…" : "Joining room…"} spinner />;
  else {
    const p = { view, send: room.send, offset: room.clockOffset };
    switch (view.phase) {
      case "lobby":
        body = <Lobby view={view} send={room.send} />;
        break;
      case "answer":
        body = <AnswerScreen {...p} />;
        break;
      case "predict":
        body = <PredictScreen {...p} />;
        break;
      case "reveal":
        body = <RevealScreen {...p} />;
        break;
      case "echo":
        body = <EchoScreen {...p} />;
        break;
      case "echo_reveal":
        body = <EchoRevealScreen {...p} />;
        break;
      case "final":
        body = <FinalScreen {...p} />;
        break;
      default:
        // A phase this build doesn't know: the server was updated mid-game.
        body = <UpdateNeeded />;
    }
  }

  return (
    <>
      <TopBar code={code} onLeave={view ? room.leave : undefined} score={view?.players.find((x) => x.id === view.you?.id)?.score} />
      {status === "reconnecting" && view && (
        <div className="banner" role="status">
          {online ? "Connection lost: reconnecting…" : "You're offline. We'll reconnect as soon as you're back."}
          <span className="banner__hint"> Your seat and score are safe.</span>
        </div>
      )}
      {room.updateAvailable && (
        <div className="banner banner--info" role="status">
          A new version of the game is live.{" "}
          <button className="banner__btn" onClick={() => location.reload()}>
            Refresh
          </button>{" "}
          <span className="banner__hint">You'll keep your seat and score.</span>
        </div>
      )}
      <Announcer view={view} />
      <Toast error={room.lastError} />
      {body}
    </>
  );
}

function TopBar({ code, onLeave, score }: { code: string; onLeave?: () => void; score?: number }) {
  const muted = useMuted();
  const shown = useTween(score ?? 0);
  return (
    <div className="topbar">
      <button className="topbar__logo" onClick={() => navigate("/")} aria-label="Read the Room home">
        RTR
      </button>
      <span className="topbar__code" aria-label={`Room ${code.split("").join(" ")}`}>
        {code}
      </span>
      {score !== undefined && (
        <span className="topbar__score" aria-label={`${score} points`}>
          {shown} pts
        </span>
      )}
      <button
        className={`topbar__sound${score === undefined ? " topbar__sound--push" : ""}`}
        aria-pressed={!muted}
        aria-label="Sound effects"
        title={muted ? "Sound off" : "Sound on"}
        onClick={() => setMuted(!muted)}
      >
        <span aria-hidden="true">{muted ? "🔇" : "🔊"}</span>
      </button>
      {onLeave && (
        <button
          className="topbar__leave"
          onClick={() => {
            if (confirm("Leave this room? Your score will be lost.")) onLeave();
          }}
        >
          Leave
        </button>
      )}
    </div>
  );
}

function Toast({ error }: { error: { message: string; at: number } | null }) {
  const [shown, setShown] = useState<typeof error>(null);
  useEffect(() => {
    if (!error) return;
    setShown(error);
    const id = window.setTimeout(() => setShown(null), 3000);
    return () => window.clearTimeout(id);
  }, [error]);
  if (!shown) return null;
  return (
    <div className="toast" role="alert">
      {shown.message}
    </div>
  );
}

function Centered({ title, children, spinner }: { title: string; children?: ReactNode; spinner?: boolean }) {
  return (
    <main className="screen centered">
      {spinner && <div className="spinner" aria-hidden="true" />}
      <h1 className="h1">{title}</h1>
      {children}
    </main>
  );
}

function JoinForm({ code, onJoin, busy, error }: { code: string; onJoin: (n: string) => void; busy: boolean; error: string | null }) {
  const [name, setName] = useState(loadName);
  const clean = name.trim();
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!clean) return;
    saveName(clean);
    onJoin(clean);
  }
  return (
    <main className="screen centered">
      <p className="eyebrow">You're invited to room</p>
      <p className="room-code__code">{code}</p>
      <form className="card join-form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Your name</span>
          <input className="input" value={name} maxLength={16} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <Button big type="submit" disabled={!clean || busy}>
          {busy ? "Joining…" : "Join game"}
        </Button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}

function UpdateNeeded() {
  return (
    <Centered title="The game was updated">
      <p className="muted">Refresh to load the new version. You'll keep your seat and score.</p>
      <Button onClick={() => location.reload()}>Refresh</Button>
    </Centered>
  );
}

/** Short sound cues on phase changes, your own lock-ins and the last seconds. */
function useGameCues(view: ClientView | null, offset: number) {
  const prev = useRef<{ key?: string; mine?: string; players?: number }>({});
  useEffect(() => {
    if (!view) return;
    const p = prev.current;
    const key = `${view.phase}:${view.round}`;
    const mine = `${view.mine.answer}|${view.mine.prediction}|${view.mine.echo}`;
    if (p.key && p.key !== key) {
      if (view.phase === "reveal" || view.phase === "echo_reveal") play("reveal");
      else if (view.phase === "echo") play("echo");
      else if (view.phase === "final") play("win");
    } else if (p.key === key && p.mine !== undefined && p.mine !== mine) play("lock");
    if (view.phase === "lobby" && p.players !== undefined && view.players.length > p.players) play("join");
    prev.current = { key, mine, players: view.players.length };
  }, [view]);

  // Soft ticks for the last 3 seconds, only while you still have to submit.
  const live = useRef(view);
  live.current = view;
  useEffect(() => {
    let last = -1;
    const id = window.setInterval(() => {
      const v = live.current;
      if (!v || v.deadline === null || !v.you?.participant) return;
      const pending =
        (v.phase === "answer" && v.mine.answer === null) ||
        (v.phase === "predict" && v.mine.prediction === null) ||
        (v.phase === "echo" && v.mine.echo === null);
      const secs = Math.ceil((v.deadline - (Date.now() + offset)) / 1000);
      if (pending && secs >= 1 && secs <= 3 && secs !== last) play("tick");
      last = secs;
    }, 200);
    return () => window.clearInterval(id);
  }, [offset]);
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, []);
  return online;
}

/** Announces each new phase to screen readers. */
function Announcer({ view }: { view: ClientView | null }) {
  let text = "";
  if (view) {
    const r = `Round ${view.round} of ${view.totalRounds}.`;
    switch (view.phase) {
      case "lobby":
        text = `Lobby. ${view.players.length} players.`;
        break;
      case "answer":
        text = `${r} ${view.prompt?.text ?? ""} Answer from 1 to 10.`;
        break;
      case "predict":
        text = "Now predict the room's average.";
        break;
      case "reveal":
        text = view.reveal?.voided ? "Not enough answers this round." : `The room said ${view.reveal?.average?.toFixed(1)}.`;
        break;
      case "echo":
        text = `${r} Echo Round: ${view.echo ? MODE_NAME[view.echo.kind] : ""}.`;
        break;
      case "echo_reveal":
        text = "Echo Round results.";
        break;
      case "final":
        text = "Final results and Room Report.";
        break;
    }
  }
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}

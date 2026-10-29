import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useRoom } from "../net/useRoom";
import { loadName, peekPendingJoin, saveName } from "../lib/storage";
import { navigate } from "../router";
import { Button } from "../components/ui";
import { Lobby } from "./Lobby";
import { AnswerScreen, FinalScreen, PredictScreen, RevealScreen } from "./Game";

export function RoomScreen({ code }: { code: string }) {
  const [initialName] = useState(() => peekPendingJoin(code));
  const room = useRoom(code, initialName);
  const { status, view, needsName } = room;

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
      case "final":
        body = <FinalScreen {...p} />;
        break;
    }
  }

  return (
    <>
      <TopBar code={code} onLeave={view ? room.leave : undefined} score={view?.players.find((x) => x.id === view.you?.id)?.score} />
      {status === "reconnecting" && view && (
        <div className="banner" role="status">
          Connection lost — reconnecting…
        </div>
      )}
      <Toast error={room.lastError} />
      {body}
    </>
  );
}

function TopBar({ code, onLeave, score }: { code: string; onLeave?: () => void; score?: number }) {
  return (
    <div className="topbar">
      <button className="topbar__logo" onClick={() => navigate("/")} aria-label="Read the Room home">
        RTR
      </button>
      <span className="topbar__code">{code}</span>
      {score !== undefined && <span className="topbar__score">{score} pts</span>}
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

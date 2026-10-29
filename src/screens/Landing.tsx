import { useState, type FormEvent } from "react";
import { createRoom, CODE_RE, getRoomInfo, normalizeCode } from "../lib/api";
import { loadName, saveName, setPendingJoin } from "../lib/storage";
import { Button } from "../components/ui";
import { navigate } from "../router";

export function Landing() {
  const [name, setName] = useState(loadName);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cleanName = name.trim();
  const nameOk = cleanName.length >= 1 && [...cleanName].length <= 16;

  async function onCreate() {
    if (!nameOk) return setError("Enter your name first.");
    setBusy("create");
    setError(null);
    try {
      const c = await createRoom();
      saveName(cleanName);
      setPendingJoin(c, cleanName);
      navigate(`/r/${c}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create a room.");
      setBusy(null);
    }
  }

  async function onJoin(e: FormEvent) {
    e.preventDefault();
    if (!nameOk) return setError("Enter your name first.");
    if (!CODE_RE.test(code)) return setError("Room codes are 4 letters.");
    setBusy("join");
    setError(null);
    try {
      const info = await getRoomInfo(code);
      if (!info.exists) {
        setError(`No room called ${code}. Check the code with your host.`);
        setBusy(null);
        return;
      }
      saveName(cleanName);
      setPendingJoin(code, cleanName);
      navigate(`/r/${code}`);
    } catch {
      setError("Couldn't reach the server. Check your connection.");
      setBusy(null);
    }
  }

  return (
    <main className="screen landing">
      <header className="hero">
        <p className="eyebrow">A party game for 2–8 phones</p>
        <h1 className="logo">
          Read <span>the</span> Room
        </h1>
        <p className="hero__lede">
          No right answers — only your friends. Answer in secret, then guess what the whole room said.
        </p>
      </header>

      <section className="card landing__form" aria-label="Play">
        <label className="field">
          <span className="field__label">Your name</span>
          <input
            className="input"
            value={name}
            maxLength={16}
            autoComplete="nickname"
            placeholder="e.g. Priya"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <Button big onClick={onCreate} disabled={busy !== null}>
          {busy === "create" ? "Creating…" : "Create a room"}
        </Button>

        <div className="divider">
          <span>or join one</span>
        </div>

        <form className="join-row" onSubmit={onJoin}>
          <input
            className="input input--code"
            value={code}
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            aria-label="Room code"
            placeholder="CODE"
            onChange={(e) => setCode(normalizeCode(e.target.value))}
          />
          <Button type="submit" kind="ghost" disabled={busy !== null}>
            {busy === "join" ? "Joining…" : "Join"}
          </Button>
        </form>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </section>

      <ol className="how" aria-label="How it works">
        <li>
          <b>Answer</b> a silly question from 1 to 10. Nobody sees your answer.
        </li>
        <li>
          <b>Predict</b> the room's average.
        </li>
        <li>
          <b>Score</b> by reading the room. Closest guess wins the round.
        </li>
      </ol>
    </main>
  );
}

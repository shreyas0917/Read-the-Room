// Real multi-client integration test. Starts the app in the actual Workers
// runtime (workerd via the Cloudflare Vite plugin, CLOUDFLARE_ENV=test for
// 10× faster timers), then drives it with independent WebSocket clients.
//
//   npm run test:integration
//   BASE_URL=https://… node tests/integration/run.mjs   (against a deployment;
//   skips the restart scenario and uses that deployment's timers)

import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = 5199;
const EXTERNAL = process.env.BASE_URL;
const BASE = EXTERNAL ?? `http://localhost:${PORT}`;
const WS_BASE = BASE.replace(/^http/, "ws");

let server = null;
let passed = 0;
const failures = [];

// --- server lifecycle --------------------------------------------------------

async function startServer() {
  server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], {
    env: { ...process.env, CLOUDFLARE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`server did not start:\n${log}`);
}

async function stopServer() {
  if (!server) return;
  const pid = server.pid;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {}
  server = null;
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${BASE}/`);
    } catch {
      return;
    }
    await sleep(150);
  }
}

// --- client ----------------------------------------------------------------------

class Client {
  constructor(label) {
    this.label = label;
    this.msgs = [];
    this.cursor = 0;
    this.view = null;
    this.playerId = null;
    this.token = null;
    this.closed = false;
    this.listeners = new Set();
  }

  connect(code) {
    this.code = code;
    this.msgs = [];
    this.cursor = 0;
    this.view = null;
    this.closed = false;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws`);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error(`${this.label}: socket error ${e.message ?? ""}`));
      ws.onclose = () => {
        this.closed = true;
        this.notify();
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        this.msgs.push(m);
        if (m.t === "state") this.view = m.view;
        if (m.t === "welcome") {
          this.playerId = m.playerId;
          if (m.token) this.token = m.token;
        }
        this.notify();
      };
    });
  }

  notify() {
    for (const l of this.listeners) l();
  }

  send(o) {
    this.ws.send(typeof o === "string" ? o : JSON.stringify(o));
  }

  /** Wait for the next unconsumed message matching pred. */
  expect(pred, what, timeout = 6000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        for (let i = this.cursor; i < this.msgs.length; i++) {
          if (pred(this.msgs[i])) {
            this.cursor = i + 1;
            cleanup();
            resolve(this.msgs[i]);
            return true;
          }
        }
        return false;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${this.label}: timed out waiting for ${what}. Last: ${JSON.stringify(this.msgs.slice(-2)).slice(0, 400)}`));
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      if (!check()) this.listeners.add(check);
    });
  }

  expectError(code, timeout) {
    return this.expect((m) => m.t === "error" && m.code === code, `error ${code}`, timeout);
  }

  /** Wait until the latest view satisfies pred (checks current view first). */
  until(pred, what, timeout = 6000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.view && pred(this.view)) {
          cleanup();
          resolve(this.view);
          return true;
        }
        return false;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${this.label}: timed out waiting for view ${what}. Phase=${this.view?.phase} round=${this.view?.round}`));
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(check);
      };
      if (!check()) this.listeners.add(check);
    });
  }

  async hello(name) {
    this.send({ t: "hello", name });
    await this.expect((m) => m.t === "welcome", "welcome");
    await this.until((v) => v.you?.id === this.playerId, "own view");
  }

  async resume() {
    this.send({ t: "resume", playerId: this.playerId, token: this.token });
    const w = await this.expect((m) => m.t === "welcome" || m.t === "error", "resume reply");
    if (w.t !== "welcome") throw new Error(`${this.label}: resume failed ${JSON.stringify(w)}`);
    return w;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// --- assertions ------------------------------------------------------------------

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function eq(a, b, msg) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`Assertion failed: ${msg}\n  expected ${jb}\n  received ${ja}`);
}

const SECRET_KEYS = ["answers", "predictions", "token", "tokens", "tokenHash", "seed", "prompts", "participants"];

/** Every state message a client ever received must be free of secret fields. */
function assertNoLeaks(client) {
  for (const m of client.msgs) {
    if (m.t !== "state") continue;
    const stack = [m.view];
    while (stack.length) {
      const x = stack.pop();
      if (x && typeof x === "object") {
        for (const [k, v] of Object.entries(x)) {
          assert(!SECRET_KEYS.includes(k), `${client.label} received secret key "${k}"`);
          stack.push(v);
        }
      }
    }
  }
}

async function createRoom() {
  const r = await fetch(`${BASE}/api/rooms`, { method: "POST" });
  const body = await r.json();
  assert(r.status === 201 && /^[A-HJKMNP-Z]{4}$/.test(body.code), `room created (${r.status} ${JSON.stringify(body)})`);
  return body.code;
}

// Mirror of the documented scoring rule, computed independently of shared/.
function expectedRound(answers, predictions) {
  const avg = answers.reduce((a, b) => a + b, 0) / answers.length;
  const dist = answers.map((a) => Math.abs(a - avg));
  const max = Math.max(...dist);
  const wildIdx = dist.filter((d) => Math.abs(d - max) < 1e-9).length === 1 && max >= 2 ? dist.indexOf(max) : -1;
  return predictions.map((p, i) => {
    const base = p === null ? 0 : Math.round(100 * Math.max(0, 1 - Math.abs(p - avg) / 3));
    const bull = p !== null && Math.abs(p - avg) <= 0.3 + 1e-9 ? 50 : 0;
    return base + bull + (i === wildIdx ? 25 : 0);
  });
}

async function scenario(name, fn) {
  const t = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t}ms)`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${String(e.stack ?? e).split("\n").slice(0, 4).join("\n    ")}`);
  }
}

// --- scenarios ----------------------------------------------------------------------

async function fullGame() {
  const code = await createRoom();
  const [A, B, C] = [new Client("Ana"), new Client("Ben"), new Client("Cy")];
  for (const c of [A, B, C]) await c.connect(code);
  await A.hello("Ana");
  await B.hello("Ben");
  await C.hello("Cy");

  // Room isolation: identities are distinct and the first joiner is host.
  assert(new Set([A.playerId, B.playerId, C.playerId]).size === 3, "distinct player ids");
  await C.until((v) => v.players.length === 3, "3 players");
  eq(C.view.hostId, A.playerId, "first joiner is host");

  // Authorization + validation.
  B.send({ t: "start" });
  await B.expectError("not_host");
  B.send({ t: "settings", rounds: 6 });
  await B.expectError("not_host");
  A.send("{not json");
  await A.expectError("bad_message");
  A.send({ t: "answer", value: 5 });
  await A.expectError("wrong_phase");
  A.send({ t: "start", force: true });
  await A.expectError("bad_message");
  A.send("x".repeat(2000));
  await A.expectError("bad_message");
  B.send({ t: "hello", name: "Ben again" });
  await B.expectError("already_joined");
  const dup = new Client("Dup");
  await dup.connect(code);
  dup.send({ t: "hello", name: "ana" });
  await dup.expectError("name_taken");
  dup.close();

  A.send({ t: "settings", rounds: 6 });
  await C.until((v) => v.settings.rounds === 6, "rounds=6 synced");
  A.send({ t: "start" });
  for (const c of [A, B, C]) await c.until((v) => v.phase === "answer" && v.round === 1, "round 1 answer");
  eq(new Set([A, B, C].map((c) => c.view.deadline)).size, 1, "all clients share one authoritative deadline");
  eq(A.view.prompt, B.view.prompt, "same prompt on every device");

  const plan = [
    { answers: [2, 4, 9], predictions: [5, 5.3, 8] },
    { answers: [5, 5, 10], predictions: [6, 6.7, 6.2] },
    { answers: [1, 1, 2], predictions: [1.3, 3, 1] },
    { answers: [7, 8, 9], predictions: [8, 8, 8] },
    { answers: [3, 6, 9], predictions: [6, 4.5, 10] },
    { answers: [10, 10, 10], predictions: [10, 9.8, 1] },
  ];
  const totals = [0, 0, 0];
  const clients = [A, B, C];
  let D = null;

  for (let r = 0; r < plan.length; r++) {
    const { answers, predictions } = plan[r];
    const round = r + 1;
    for (const c of clients) await c.until((v) => v.phase === "answer" && v.round === round, `round ${round} answer`);

    if (round === 2) {
      // Disconnect Ben mid-round; the room must not wait for him.
      B.close();
      await A.until((v) => v.players.find((p) => p.id === B.playerId)?.connected === false, "Ben shown away");
    }

    A.send({ t: "answer", value: answers[0] });
    await C.until((v) => v.submittedCount >= 1, "submission count visible");
    // Privacy: C sees that Ana submitted, but not what.
    eq(C.view.mine.answer, null, "C cannot see A's answer");
    assert(C.view.players.find((p) => p.id === A.playerId).submitted === true, "C sees A has submitted");
    // Abuse probes only in early rounds: at 10x test speed, probing every
    // round would (correctly) trip the per-socket rate limiter.
    if (round <= 2) {
      A.send({ t: "answer", value: answers[0] });
      await A.expectError("already_submitted");
      A.send({ t: "predict", value: 5 });
      await A.expectError("wrong_phase");
    }

    if (round === 2) {
      C.send({ t: "answer", value: answers[2] });
      await A.until((v) => v.phase === "predict", "predict without waiting for Ben");
      // Ben comes back with his token: same seat, same score.
      await B.connect(code);
      const w = await B.resume();
      eq(w.resumed, true, "resume acknowledged");
      const bv = await B.until((v) => v.you?.id === B.playerId, "Ben's resumed view");
      eq(bv.phase, "predict", "Ben resumes into the live phase");
      eq(bv.players.find((p) => p.id === B.playerId).score, totals[1], "Ben's score restored");
      eq(bv.mine.answer, null, "Ben did not answer round 2");
      answers[1] = null;
    } else {
      B.send({ t: "answer", value: answers[1] });
      C.send({ t: "answer", value: answers[2] });
    }

    for (const c of clients) await c.until((v) => v.phase === "predict" && v.round === round, `round ${round} predict`);
    for (let i = 0; i < 3; i++) eq(clients[i].view.mine.answer, answers[i], `${clients[i].label} sees own answer`);

    if (round <= 2) {
      A.send({ t: "predict", value: 11 });
      await A.expectError("bad_message");
    }
    for (let i = 0; i < 3; i++) clients[i].send({ t: "predict", value: predictions[i] });
    for (const c of clients) await c.until((v) => v.phase === "reveal" && v.round === round, `round ${round} reveal`);

    const valid = answers.filter((a) => a !== null);
    const expected = expectedRound(valid, predictions);
    if (answers[1] === null) {
      // Ben had no answer; recompute with his prediction but no wildcard eligibility.
      const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
      const dist = valid.map((a) => Math.abs(a - avg));
      const max = Math.max(...dist);
      const unique = dist.filter((d) => Math.abs(d - max) < 1e-9).length === 1 && max >= 2;
      const wild = unique ? [0, 2][dist.indexOf(max)] : -1;
      for (let i = 0; i < 3; i++) {
        const p = predictions[i];
        const base = Math.round(100 * Math.max(0, 1 - Math.abs(p - avg) / 3));
        expected[i] = base + (Math.abs(p - avg) <= 0.3 + 1e-9 ? 50 : 0) + (i === wild ? 25 : 0);
      }
    }
    const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
    for (const c of clients) {
      const rv = c.view.reveal;
      assert(Math.abs(rv.average - avg) < 1e-9, `${c.label} average ${rv.average} vs ${avg}`);
      eq(rv.answerCount, valid.length, "answer count");
      eq(rv.counts.reduce((a, b) => a + b, 0), valid.length, "anonymous counts sum");
    }
    for (let i = 0; i < 3; i++) {
      totals[i] += expected[i];
      const mine = A.view.reveal.guesses.find((g) => g.playerId === clients[i].playerId);
      eq(mine.score.total, expected[i], `round ${round} ${clients[i].label} points`);
    }
    eq(
      clients.map((c) => A.view.players.find((p) => p.id === c.playerId).score),
      totals,
      `running totals after round ${round}`,
    );
    for (const c of clients) eq(c.view.players.map((p) => p.score), A.view.players.map((p) => p.score), "scores in sync");

    if (round === 3) {
      // Late joiner spectates; forged / bad credentials are rejected.
      D = new Client("Dee");
      await D.connect(code);
      await D.hello("Dee");
      eq(D.view.you.role, "spectator", "mid-game joiner is a spectator");
      const evil = new Client("Evil");
      await evil.connect(code);
      evil.send({ t: "resume", playerId: A.playerId, token: "A".repeat(43) });
      await evil.expectError("bad_token");
      evil.send({ t: "answer", value: 5 });
      await evil.expectError("not_joined");
      evil.close();
    }

    if (round <= 2) {
      B.send({ t: "next" });
      await B.expectError("not_host");
    }
    A.send({ t: "next" });
    if (D && round < plan.length) {
      await D.until((v) => v.phase === "answer" && v.round === round + 1, "Dee sees next round");
      D.send({ t: "answer", value: 5 });
      await D.expectError("not_participant");
    }
  }

  for (const c of [A, B, C]) await c.until((v) => v.phase === "final", "final");
  const st = A.view.standings;
  eq(st.length, 3, "three ranked players (spectator excluded)");
  const byId = Object.fromEntries(st.map((s) => [s.playerId, s.score]));
  eq([byId[A.playerId], byId[B.playerId], byId[C.playerId]], totals, "final scores match independent tally");
  eq(A.view.rounds.length, 6, "recap has every round");

  A.send({ t: "play_again" });
  for (const c of [A, B, C]) await c.until((v) => v.phase === "lobby", "rematch lobby");
  assert(A.view.players.every((p) => p.score === 0), "scores reset on rematch");
  assert(A.view.players.filter((p) => p.role === "player").length === 4, "spectator promoted on rematch");

  for (const c of [A, B, C, D]) assertNoLeaks(c);
  for (const c of [A, B, C, D]) c.close();
}

async function deadlinesWithoutSubmissions() {
  const code = await createRoom();
  const [A, B] = [new Client("A"), new Client("B")];
  await A.connect(code);
  await B.connect(code);
  await A.hello("A");
  await B.hello("B");
  A.send({ t: "start" });
  const v1 = await B.until((v) => v.phase === "answer" && v.round === 1, "round 1");
  const started = Date.now();
  const expected = v1.deadline - v1.serverNow;
  // Reveal lasts 0.6x the answer phase; allow generous slack on top.
  const budget = expected * 1.6 + 5000;
  // Nobody submits: answer deadline → voided reveal → next round, all by alarm.
  const rv = await B.until((v) => v.phase === "reveal", "auto reveal", budget);
  eq(rv.reveal.voided, true, "empty round voided");
  await B.until((v) => v.phase === "answer" && v.round === 2, "auto next round", budget);
  const elapsed = Date.now() - started;
  assert(elapsed >= expected * 0.8, `deadline not early (${elapsed}ms vs ${expected}ms)`);
  assert(A.view.players.every((p) => p.score === 0), "no points for voided rounds");
  A.close();
  B.close();
}

async function rateLimit() {
  const code = await createRoom();
  const c = new Client("Spam");
  await c.connect(code);
  for (let i = 0; i < 60; i++) c.send({ t: "ping" });
  await c.expectError("rate_limited");
  for (let i = 0; i < 60; i++) if (!c.closed) c.send({ t: "ping" });
  await new Promise((r) => setTimeout(r, 500));
  assert(c.closed, "socket closed after hard rate limit");
}

async function survivesRestart() {
  const code = await createRoom();
  const [A, B] = [new Client("A"), new Client("B")];
  await A.connect(code);
  await B.connect(code);
  await A.hello("A");
  await B.hello("B");
  A.send({ t: "start" });
  await A.until((v) => v.phase === "answer", "answer");
  A.send({ t: "answer", value: 2 });
  B.send({ t: "answer", value: 8 });
  await A.until((v) => v.phase === "predict", "predict");
  A.send({ t: "predict", value: 5 });
  B.send({ t: "predict", value: 4 });
  const before = await A.until((v) => v.phase === "reveal", "reveal");
  const scores = before.players.map((p) => [p.id, p.score]);
  assert(scores.some(([, s]) => s > 0), "someone scored");

  // Kill the whole runtime (Durable Object evicted, memory gone), restart.
  await stopServer();
  await startServer();

  await A.connect(code);
  await B.connect(code);
  await A.resume();
  await B.resume();
  const after = await A.until((v) => v.you?.id === A.playerId, "view after restart");
  eq(after.code, code, "same room");
  eq(after.players.map((p) => [p.id, p.score]), scores, "seats and scores survived restart");
  assert(after.round >= 1 && after.phase !== "lobby", `game still in progress (phase=${after.phase} round=${after.round})`);
  eq(after.hostId, A.playerId, "host preserved");
  // Alarms resume after restart: the game keeps advancing on its own.
  await A.until((v) => v.round >= 2 && v.phase === "answer", "alarm resumes after restart", 10000);
  A.close();
  B.close();
}

// --- main ----------------------------------------------------------------------------

try {
  if (!EXTERNAL) await startServer();
  console.log(`Integration tests against ${BASE}`);
  await scenario("full 6-round game: 3 players + spectator, sync, privacy, reconnect, validation, rematch", fullGame);
  await scenario("deadlines advance with no submissions", deadlinesWithoutSubmissions);
  await scenario("per-socket rate limiting", rateLimit);
  if (!EXTERNAL) await scenario("room state survives a full runtime restart", survivesRestart);
} finally {
  await stopServer();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

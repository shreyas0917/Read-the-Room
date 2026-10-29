// Real multi-client integration test. Starts the app in the actual Workers
// runtime (workerd via the Cloudflare Vite plugin, CLOUDFLARE_ENV=test for
// 2× faster timers), then drives it with independent WebSocket clients.
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

const SECRET_KEYS = ["answers", "predictions", "choices", "token", "tokens", "tokenHash", "seed", "prompts", "participants"];
/** Extra keys that must not appear while an Echo question is open. */
const ECHO_SECRET_KEYS = ["truth", "subjectId"];

/** Every state message a client ever received must be free of secret fields. */
function assertNoLeaks(client) {
  for (const m of client.msgs) {
    if (m.t !== "state") continue;
    const forbidden = m.view.phase === "echo" ? [...SECRET_KEYS, ...ECHO_SECRET_KEYS] : SECRET_KEYS;
    const stack = [m.view];
    while (stack.length) {
      const x = stack.pop();
      if (x && typeof x === "object") {
        for (const [k, v] of Object.entries(x)) {
          assert(!forbidden.includes(k), `${client.label} received secret key "${k}" in phase ${m.view.phase}`);
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
// `answers[i]` is null for a player who didn't answer (no Wildcard eligibility).
function expectedRegular(answers, predictions) {
  const idx = answers.map((a, i) => (a === null ? -1 : i)).filter((i) => i >= 0);
  const vals = idx.map((i) => answers[i]);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const dist = vals.map((a) => Math.abs(a - avg));
  const max = Math.max(...dist);
  const wild = dist.filter((d) => Math.abs(d - max) < 1e-9).length === 1 && max >= 2 ? idx[dist.indexOf(max)] : -1;
  return predictions.map((p, i) => {
    const base = p === null ? 0 : Math.round(100 * Math.max(0, 1 - Math.abs(p - avg) / 3));
    const bull = p !== null && Math.abs(p - avg) <= 0.3 + 1e-9 ? 50 : 0;
    return base + bull + (i === wild ? 25 : 0);
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
  A.send({ t: "echo", choice: 0 });
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

  // Rounds 3 and 6 are Echo Rounds; regular rounds follow this plan.
  const plan = {
    1: { answers: [2, 4, 9], predictions: [5, 5.3, 8] },
    2: { answers: [5, 5, 10], predictions: [6, 6.7, 6.2] },
    4: { answers: [7, 8, 9], predictions: [8, 8, 8] },
    5: { answers: [3, 6, 9], predictions: [6, 4.5, 10] },
  };
  const totals = [0, 0, 0];
  const clients = [A, B, C];
  let D = null;

  for (let round = 1; round <= 6; round++) {
    if (round % 3 === 0) {
      const pts = await playEchoRound(round, clients, plan, { code, reconnect: round === 3 ? B : null, probe: round === 3 });
      for (let i = 0; i < 3; i++) totals[i] += pts[i];
    } else {
      const { answers, predictions } = plan[round];
      for (const c of clients) await c.until((v) => v.phase === "answer" && v.round === round, `round ${round} answer`);
      plan[round].promptId = A.view.prompt.id;

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
      if (round <= 2) {
        A.send({ t: "answer", value: answers[0] });
        await A.expectError("already_submitted");
        A.send({ t: "predict", value: 5 });
        await A.expectError("wrong_phase");
        A.send({ t: "echo", choice: 0 });
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

      const expected = expectedRegular(answers, predictions);
      const valid = answers.filter((a) => a !== null);
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

    if (round <= 3) {
      B.send({ t: "next" });
      await B.expectError("not_host");
    }
    A.send({ t: "next" });
    if (D && round < 6) {
      const v = await D.until((x) => x.round === round + 1 && (x.phase === "answer" || x.phase === "echo"), "Dee sees next round");
      D.send(v.phase === "echo" ? { t: "echo", choice: 0 } : { t: "answer", value: 5 });
      await D.expectError("not_participant");
    }
  }

  for (const c of [A, B, C]) await c.until((v) => v.phase === "final", "final");
  const st = A.view.standings;
  eq(st.length, 3, "three ranked players (spectator excluded)");
  const byId = Object.fromEntries(st.map((s) => [s.playerId, s.score]));
  eq([byId[A.playerId], byId[B.playerId], byId[C.playerId]], totals, "final scores match independent tally");
  eq(A.view.rounds.length, 4, "recap lists the regular rounds");

  A.send({ t: "play_again" });
  for (const c of [A, B, C]) await c.until((v) => v.phase === "lobby", "rematch lobby");
  assert(A.view.players.every((p) => p.score === 0), "scores reset on rematch");
  assert(A.view.players.filter((p) => p.role === "player").length === 4, "spectator promoted on rematch");

  for (const c of [A, B, C, D]) assertNoLeaks(c);
  for (const c of [A, B, C, D]) c.close();
}

/** The question part of an EchoView (what must be identical on every device). */
function question(e) {
  const { result, youAreSubject, first, ...rest } = e;
  return rest;
}

/** Independent expected truth for count / pattern, from the test's own plan. */
function expectedTruth(e, plan) {
  const valid = (r) => plan[r].answers.filter((a) => a !== null);
  if (e.kind === "count") {
    eq(e.max, valid(e.sourceRound).length, "count: max is the source answer count");
    return valid(e.sourceRound).filter((v) => v > e.threshold).length;
  }
  if (e.kind === "pattern") {
    const roundOf = (promptId) => Number(Object.keys(plan).find((r) => plan[r].promptId === promptId));
    const values = e.promptOptions.map((p) => {
      const vals = valid(roundOf(p.id));
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      if (e.metric === "highest") return m;
      if (e.metric === "lowest") return -m;
      return Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / vals.length);
    });
    const best = Math.max(...values);
    const second = Math.max(...values.filter((_, i) => i !== values.indexOf(best)));
    assert(best - second >= 0.1 - 1e-9, "pattern: unambiguous winner");
    return values.indexOf(best);
  }
  return null;
}

function echoPoints(e, truth, choice) {
  if (choice === null) return 0;
  if (e.kind === "count") return Math.abs(choice - truth) === 0 ? 100 : Math.abs(choice - truth) === 1 ? 50 : 0;
  return choice === truth ? 100 : 0;
}

/**
 * Plays one Echo Round with every client, verifying sync, privacy, validation
 * and scoring against independently computed expectations. Returns points per client.
 */
async function playEchoRound(round, clients, plan, { code, reconnect = null, probe = false }) {
  for (const c of clients) await c.until((v) => v.phase === "echo" && v.round === round, `round ${round} echo`);
  const e = clients[0].view.echo;
  for (const c of clients) eq(question(c.view.echo), question(e), `${c.label} sees the same echo question`);
  eq(clients[0].view.echo.first, round === 3, "first-echo flag");
  assert(e.kind !== "who", "no Who Said It without consent");
  const truth = expectedTruth(e, plan);
  const max = e.kind === "count" ? e.max : e.promptOptions.length - 1;

  const [A] = clients;
  if (probe) {
    A.send({ t: "answer", value: 5 });
    await A.expectError("wrong_phase");
    A.send({ t: "echo", choice: 99 });
    await A.expectError("bad_message");
    A.send({ t: "echo", choice: max + 1 });
    await A.expectError("invalid_value");
  }

  const picks = clients.map((_, i) => (i === 0 ? truth : i === 1 ? Math.min(truth + 1, max) : 0));
  const pickOf = (i) => (e.kind === "pattern" && i === 1 ? (truth + 1) % 3 : picks[i]);

  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    if (i === clients.length - 1) break; // last one goes after the reconnect check
    c.send({ t: "echo", choice: pickOf(i) });
    await c.until((v) => v.mine.echo === pickOf(i), `${c.label} pick recorded`);
  }
  if (probe) {
    A.send({ t: "echo", choice: pickOf(0) });
    await A.expectError("already_submitted");
    // Others see that A picked, never what.
    const other = clients[clients.length - 1];
    await other.until((v) => v.players.find((p) => p.id === A.playerId).submitted === true, "submitted flag visible");
    eq(other.view.mine.echo, null, "no one else's pick visible");
  }

  if (reconnect) {
    // Drop and resume mid-Echo: same question, own pick preserved.
    const idx = clients.indexOf(reconnect);
    reconnect.close();
    await A.until((v) => v.players.find((p) => p.id === reconnect.playerId)?.connected === false, "away during echo");
    await reconnect.connect(code);
    await reconnect.resume();
    const rv = await reconnect.until((v) => v.you?.id === reconnect.playerId && v.phase === "echo", "resumed into echo");
    eq(question(rv.echo), question(e), "same echo question after reconnect");
    eq(rv.mine.echo, pickOf(idx), "own pick preserved across reconnect");
  }

  const last = clients.length - 1;
  clients[last].send({ t: "echo", choice: pickOf(last) });
  for (const c of clients) await c.until((v) => v.phase === "echo_reveal" && v.round === round, `round ${round} echo reveal`);
  const res = clients[0].view.echo.result;
  eq(res.truth, truth, `round ${round} ${e.kind}: server truth matches independent computation`);
  const pts = clients.map((c, i) => echoPoints(e, truth, pickOf(i)));
  for (let i = 0; i < clients.length; i++) {
    const pk = res.picks.find((p) => p.playerId === clients[i].playerId);
    eq(pk.choice, pickOf(i), "pick revealed");
    eq(pk.score.total, pts[i], `round ${round} ${clients[i].label} echo points`);
  }
  if (e.kind === "count") eq(res.counts.reduce((a, b) => a + b, 0), e.max, "source counts shown at reveal");
  return pts;
}

async function echoModes() {
  // Four consenting players, 9 rounds → every Echo mode, including Who Said It.
  const code = await createRoom();
  const names = ["Ana", "Ben", "Cy", "Di"];
  const clients = names.map((n) => new Client(n));
  for (const c of clients) await c.connect(code);
  for (let i = 0; i < 4; i++) await clients[i].hello(names[i]);
  const [A] = clients;
  for (const c of clients) {
    c.send({ t: "consent", value: true });
    await c.until((v) => v.you?.onRecord === true, `${c.label} on the record`);
  }
  await A.until((v) => v.onRecordCount === 4, "consent count");
  for (const c of clients) {
    const st = c.view.players.map((p) => Object.keys(p));
    assert(st.every((k) => !k.includes("onRecord")), "no per-player consent flags in views");
  }
  A.send({ t: "settings", rounds: 9 });
  await A.until((v) => v.settings.rounds === 9, "9 rounds");
  A.send({ t: "start" });
  await A.until((v) => v.phase === "answer", "started");
  A.send({ t: "consent", value: false });
  await A.expectError("wrong_phase");

  // No Wildcards (max distance < 2) and distinct, unique-ish answers.
  const plan = {
    1: { answers: [4, 5, 6, 7] },
    2: { answers: [1, 2, 3, 4] },
    4: { answers: [7, 8, 9, 10] },
    5: { answers: [3, 4, 4, 5] },
    7: { answers: [5, 6, 6, 7] },
    8: { answers: [2, 3, 3, 4] },
  };
  const kinds = [];
  for (let round = 1; round <= 9; round++) {
    if (round % 3 !== 0) {
      for (const c of clients) await c.until((v) => v.phase === "answer" && v.round === round, `round ${round}`);
      plan[round].promptId = A.view.prompt.id;
      clients.forEach((c, i) => c.send({ t: "answer", value: plan[round].answers[i] }));
      await A.until((v) => v.phase === "predict", "predict");
      clients.forEach((c) => c.send({ t: "predict", value: 5 }));
      await A.until((v) => v.phase === "reveal" && v.round === round, "reveal");
    } else {
      for (const c of clients) await c.until((v) => v.phase === "echo" && v.round === round, `echo ${round}`);
      const e = A.view.echo;
      for (const c of clients) eq(question(c.view.echo), question(e), "same question everywhere");
      kinds.push(e.kind);
      if (e.kind === "who") {
        const subjects = clients.filter((c) => c.view.echo.youAreSubject);
        eq(subjects.length, 1, "exactly one client is told it's them");
        const subject = subjects[0];
        const si = clients.indexOf(subject);
        eq(plan[e.sourceRound].answers[si], e.value, "the subject really gave that answer");
        eq(plan[e.sourceRound].answers.filter((v) => v === e.value).length, 1, "and it was unique");
        const truth = e.playerOptions.indexOf(subject.playerId);
        assert(truth >= 0, "subject is among the options");
        // Every view of the question omits who it is.
        for (const c of clients) {
          const raw = JSON.stringify(c.view);
          assert(!raw.includes('"subjectId"') && !raw.includes('"truth"'), `${c.label}: no subject/truth before reveal`);
        }
        const notSelf = (c) => e.playerOptions.findIndex((id) => id !== c.playerId && id !== subject.playerId);
        const picks = clients.map((c, i) => (c === subject ? notSelf(c) : i % 2 === 0 ? truth : notSelf(c)));
        subject.send({ t: "echo", choice: e.playerOptions.indexOf(subject.playerId) });
        await subject.expectError("invalid_value");
        clients.forEach((c, i) => c.send({ t: "echo", choice: picks[i] }));
        await A.until((v) => v.phase === "echo_reveal", "who reveal");
        const res = A.view.echo.result;
        eq(res.subjectId, subject.playerId, "subject named at reveal");
        eq(res.truth, truth, "who truth");
        const wrong = clients.filter((c, i) => c !== subject && picks[i] !== truth).length;
        for (let i = 0; i < 4; i++) {
          const sc = res.picks.find((p) => p.playerId === clients[i].playerId).score;
          const want = clients[i] === subject ? Math.min(100, 25 * wrong) : picks[i] === truth ? 100 : 0;
          eq(sc.total, want, `who points for ${clients[i].label}`);
        }
      } else {
        const truth = expectedTruth(e, plan);
        clients.forEach((c) => c.send({ t: "echo", choice: truth }));
        await A.until((v) => v.phase === "echo_reveal", "echo reveal");
        eq(A.view.echo.result.truth, truth, `${e.kind} truth`);
      }
    }
    A.send({ t: "next" });
  }
  await A.until((v) => v.phase === "final", "final");
  eq([...new Set(kinds)].sort(), ["count", "pattern", "who"], `all three modes played (got ${kinds.join(", ")})`);
  for (const c of clients) assertNoLeaks(c);
  for (const c of clients) c.close();
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
  await A.until((v) => v.round >= 2 && v.phase === "answer", "alarm resumes after restart", 15000);

  // Round 2, then the Echo Round 3 — and kill the runtime in the middle of it.
  A.send({ t: "answer", value: 3 });
  B.send({ t: "answer", value: 6 });
  await A.until((v) => v.phase === "predict" && v.round === 2, "round 2 predict");
  A.send({ t: "predict", value: 4.5 });
  B.send({ t: "predict", value: 4.5 });
  await A.until((v) => v.phase === "reveal" && v.round === 2, "round 2 reveal");
  A.send({ t: "next" });
  const ev = await A.until((v) => v.phase === "echo" && v.round === 3, "echo round 3");
  B.send({ t: "echo", choice: 1 });
  await B.until((v) => v.mine.echo === 1, "B picked before restart");
  const q = question(ev.echo);

  await stopServer();
  await startServer();

  await A.connect(code);
  await B.connect(code);
  await A.resume();
  await B.resume();
  const ra = await A.until((v) => v.you?.id === A.playerId, "A after restart");
  const rb = await B.until((v) => v.you?.id === B.playerId, "B after restart");
  eq(ra.round, 3, "still round 3 after restart");
  assert(ra.phase === "echo" || ra.phase === "echo_reveal", `still in the Echo Round (phase=${ra.phase})`);
  eq(question(ra.echo), q, "identical Echo question after a runtime restart");
  eq(rb.mine.echo, 1, "pick made before the restart survived");
  if (ra.phase === "echo") {
    A.send({ t: "echo", choice: 0 });
    await A.until((v) => v.phase === "echo_reveal", "echo reveal after restart");
  }
  eq(A.view.echo.result.picks.find((p) => p.playerId === B.playerId).choice, 1, "pre-restart pick counted");
  A.close();
  B.close();
}

// --- main ----------------------------------------------------------------------------

try {
  if (!EXTERNAL) await startServer();
  console.log(`Integration tests against ${BASE}`);
  await scenario("full 6-round game with 2 Echo Rounds: 3 players + spectator, sync, privacy, reconnects, validation, rematch", fullGame);
  await scenario("Echo Rounds: all three modes with consent, Who Said It privacy, independent scoring", echoModes);
  await scenario("deadlines advance with no submissions", deadlinesWithoutSubmissions);
  await scenario("per-socket rate limiting", rateLimit);
  if (!EXTERNAL) await scenario("room state and an in-progress Echo Round survive full runtime restarts", survivesRestart);
} finally {
  await stopServer();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

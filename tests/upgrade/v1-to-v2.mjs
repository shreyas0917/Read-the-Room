// Real upgrade test: a room created and persisted by an OLD version of the
// code must keep working after the NEW version takes over its storage —
// the same thing that happens to live rooms on `wrangler deploy`.
//
//   node tests/upgrade/v1-to-v2.mjs <oldCommit> <scratchDir>
//
// Creates two temporary git worktrees under <scratchDir> (old commit and
// HEAD), links them to this repo's node_modules, plays part of a game on the
// old code, moves its Durable Object storage to the new code, resumes every
// player with their real resume tokens and keeps playing. Worktrees are
// removed at the end. Nothing leaves the machine.

import { execSync, spawn } from "node:child_process";
import { cpSync, existsSync, lstatSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [oldRef, scratchArg] = process.argv.slice(2);
if (!oldRef || !scratchArg) {
  console.error("usage: node tests/upgrade/v1-to-v2.mjs <oldCommit> <scratchDir>");
  process.exit(2);
}
const REPO = resolve(".");
const SCRATCH = resolve(scratchArg);
const OLD = join(SCRATCH, "rtr-old");
const NEW = join(SCRATCH, "rtr-new");
const PORT = 5196;
const BASE = `http://localhost:${PORT}`;

const sh = (cmd, cwd = REPO) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
function assert(c, m) {
  if (!c) throw new Error(`Assertion failed: ${m}`);
}

/**
 * Removes the node_modules junction FIRST. Deleting a worktree that still
 * contains a junction can recurse into the junction's target — i.e. this
 * repo's real node_modules. unlink removes only the link itself.
 */
function unlinkModules(dir) {
  const link = join(dir, "node_modules");
  try {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  } catch {}
  if (existsSync(link)) throw new Error(`refusing to delete worktree: ${link} is not a removable link`);
}

function dropWorktree(dir) {
  if (!existsSync(dir)) return;
  unlinkModules(dir);
  try {
    sh(`git worktree remove --force "${dir}"`);
  } catch {
    // Left over from an interrupted run and no longer registered: the link
    // is already gone (checked above), so a plain delete is safe.
    rmSync(dir, { recursive: true, force: true });
  }
}

function worktree(dir, ref) {
  dropWorktree(dir);
  sh(`git worktree add --detach "${dir}" ${ref}`);
  // Share dependencies; both versions use the same package set.
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "junction");
}

let server = null;
async function start(dir) {
  server = spawn(process.execPath, [join(REPO, "node_modules/vite/bin/vite.js"), "--port", String(PORT), "--strictPort"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`server in ${dir} did not start:\n${log}`);
}
async function stop() {
  if (!server) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
    else server.kill("SIGKILL");
  } catch {}
  server = null;
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(BASE);
    } catch {
      return;
    }
    await sleep(150);
  }
}

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.view = null;
    this.waiters = new Set();
  }
  connect(code) {
    this.view = null;
    return new Promise((res, rej) => {
      this.ws = new WebSocket(`${BASE.replace("http", "ws")}/api/rooms/${code}/ws`);
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error(`${this.name} socket error`));
      this.ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        this.msgs.push(m);
        if (m.t === "welcome") {
          this.id = m.playerId;
          if (m.token) this.token = m.token;
        }
        if (m.t === "state") this.view = m.view;
        for (const w of this.waiters) w();
      };
    });
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  until(pred, what, ms = 15000) {
    return new Promise((res, rej) => {
      const check = () => {
        if (this.view && pred(this.view)) {
          clearTimeout(t);
          this.waiters.delete(check);
          res(this.view);
        }
      };
      const t = setTimeout(() => {
        this.waiters.delete(check);
        rej(new Error(`${this.name}: timeout waiting for ${what} (phase=${this.view?.phase} round=${this.view?.round})`));
      }, ms);
      this.waiters.add(check);
      check();
    });
  }
  close() {
    this.ws.close();
  }
}

try {
  console.log(`old: ${sh(`git rev-parse --short ${oldRef}`)}   new: ${sh("git rev-parse --short HEAD")}`);
  worktree(OLD, oldRef);
  worktree(NEW, "HEAD");

  // --- 1. Old code: start a game, finish round 1, get into round 2 --------------
  await start(OLD);
  const r = await fetch(`${BASE}/api/rooms`, { method: "POST" });
  const { code } = await r.json();
  const players = ["Ana", "Ben", "Cy"].map((n) => new Client(n));
  for (const p of players) {
    await p.connect(code);
    p.send({ t: "hello", name: p.name });
    await p.until((v) => v.you, "joined");
  }
  const [A] = players;
  A.send({ t: "start" });
  await A.until((v) => v.phase === "answer", "round 1");
  [2, 5, 9].forEach((v, i) => players[i].send({ t: "answer", value: v }));
  await A.until((v) => v.phase === "predict", "predict 1");
  [5, 5.3, 7].forEach((v, i) => players[i].send({ t: "predict", value: v }));
  const rev = await A.until((v) => v.phase === "reveal", "reveal 1");
  assert(!("echo" in rev), "old code has no Echo fields (it really is v1)");
  const scores = Object.fromEntries(rev.players.map((p) => [p.id, p.score]));
  A.send({ t: "next" });
  await A.until((v) => v.phase === "answer" && v.round === 2, "round 2");
  A.send({ t: "answer", value: 4 });
  await A.until((v) => v.submittedCount === 1, "A answered round 2");
  for (const p of players) p.close();
  await stop();
  console.log(`  v1 room ${code}: round 2 in progress, scores ${JSON.stringify(Object.values(scores))}`);

  // --- 2. Move the storage to the new code ----------------------------------
  rmSync(join(NEW, ".wrangler"), { recursive: true, force: true });
  cpSync(join(OLD, ".wrangler", "state"), join(NEW, ".wrangler", "state"), { recursive: true });

  // --- 3. New code: resume everyone with their real tokens, keep playing -----
  await start(NEW);
  for (const p of players) {
    await p.connect(code);
    p.send({ t: "resume", playerId: p.id, token: p.token });
    await p.until((v) => v.you?.id === p.id, `${p.name} resumed on new code`);
  }
  const v = A.view;
  assert("echo" in v && "onRecordCount" in v, "now served by the new code");
  assert(v.code === code, "same room");
  assert(v.round === 2, `still round 2 (got ${v.round}, phase ${v.phase})`);
  for (const p of v.players) assert(p.score === scores[p.id], `${p.name}'s score survived the upgrade`);
  assert(v.hostId === A.id, "host survived");
  if (v.phase === "answer") {
    assert(v.mine.answer === 4, "A's round-2 answer from the old code survived");
    players[1].send({ t: "answer", value: 6 });
    players[2].send({ t: "answer", value: 8 });
    await A.until((x) => x.phase === "predict", "predict 2 on new code");
  }
  if (A.view.phase === "predict") {
    players.forEach((p) => p.send({ t: "predict", value: 6 }));
    await A.until((x) => x.phase === "reveal", "reveal 2 on new code");
  }
  A.send({ t: "next" });
  const e = await A.until((x) => x.round === 3, "round 3 on new code");
  assert(e.phase === "echo", `round 3 of the upgraded game is an Echo Round (phase ${e.phase})`);
  console.log(`  upgraded room: round 3 is a "${e.echo.kind}" Echo Round built from v1 history`);
  for (const p of players) {
    const opts = e.echo.kind === "count" ? e.echo.max + 1 : (e.echo.promptOptions ?? e.echo.playerOptions).length;
    p.send({ t: "echo", choice: Math.min(1, opts - 1) });
  }
  await A.until((x) => x.phase === "echo_reveal", "echo reveal on upgraded room");
  for (const p of players) p.close();
  console.log("PASS: v1 room upgraded in place and played on");
  process.exitCode = 0;
} catch (err) {
  console.log(`FAIL: ${err.message}`);
  process.exitCode = 1;
} finally {
  await stop();
  for (const dir of [OLD, NEW]) {
    try {
      dropWorktree(dir);
    } catch (e) {
      console.log(`cleanup: ${e.message} (left ${dir} in place)`);
    }
  }
  sh("git worktree prune");
  // Guard against the failure this script once caused: the repo's own
  // dependencies must still be there.
  if (!existsSync(join(REPO, "node_modules", "vite", "bin", "vite.js"))) {
    console.log("FAIL: repo node_modules damaged; run npm ci");
    process.exitCode = 1;
  }
}

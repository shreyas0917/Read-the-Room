// Room Durable Object: one instance per room code, the single authority for
// that room. It authenticates sockets, feeds validated actions to the pure
// engine, persists the result, schedules the alarm and broadcasts redacted
// per-player views.
//
// Consistency: state lives in synchronous SQLite-backed KV (`ctx.storage.kv`),
// and every mutation happens in one synchronous block (load → apply → put →
// schedule → broadcast). The only awaits (token hashing) happen *before* that
// block, and state is re-read after them, so events cannot interleave
// mid-mutation. Outgoing messages are held by the output gate until the write
// is durable, so clients never see state that could be lost.

import { DurableObject } from "cloudflare:workers";
import { applyAction, createRoom, isAbandoned, migrateState, nextWakeTime, type EngineAction } from "../shared/engine";
import { parseClientMessage, type ClientMessage, type ErrorCode, type RoomState, type ServerMessage } from "../shared/protocol";
import { viewFor } from "../shared/redact";

interface Attachment {
  pid: string | null;
}

const MAX_SOCKETS = 32;
const RATE_WINDOW_MS = 10_000;
const RATE_SOFT_LIMIT = 40;
const RATE_HARD_LIMIT = 80;

const ERROR_TEXT: Record<ErrorCode, string> = {
  bad_message: "That message wasn't understood.",
  not_joined: "You're not in this room.",
  already_joined: "You're already in this room.",
  invalid_name: "Pick a name between 1 and 16 characters.",
  name_taken: "Someone in this room already has that name.",
  room_full: "This room is full.",
  bad_token: "Your seat could not be restored.",
  not_host: "Only the host can do that.",
  wrong_phase: "That's not possible right now.",
  already_submitted: "You've already locked that in.",
  invalid_value: "That value isn't allowed.",
  not_enough_players: "You need at least two connected players to start.",
  not_participant: "You're spectating this game — you'll play in the next one.",
  rate_limited: "Slow down a little.",
  room_closed: "This room has closed.",
};

function send(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket already closing; the close handler will clean up.
  }
}

function sendError(ws: WebSocket, code: ErrorCode, message?: string): void {
  send(ws, { t: "error", code, message: message ?? ERROR_TEXT[code] });
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RoomInfo {
  exists: boolean;
  phase?: RoomState["phase"];
  players?: number;
}

export class Room extends DurableObject<Env> {
  private state: RoomState | null;
  /** sha256(token) → playerId. Raw tokens are never stored. */
  private tokens: Record<string, string>;
  private rates = new Map<WebSocket, { start: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Rooms saved by an older deploy are upgraded in place on first load.
    this.state = migrateState(ctx.storage.kv.get<unknown>("state"));
    this.tokens = ctx.storage.kv.get<Record<string, string>>("tokens") ?? {};
  }

  // --- RPC from the front Worker -------------------------------------------

  /**
   * Creates the room if this code is free. `testSeed` is only ever passed by
   * the front Worker when the deployment sets ALLOW_TEST_SEED (test env).
   */
  async init(code: string, testSeed?: number): Promise<boolean> {
    const now = Date.now();
    if (this.state && !isAbandoned(this.state, now)) return false;
    const seed = testSeed ?? crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
    const scale = Math.min(1, Math.max(0.05, Number(this.env.TIMER_SCALE) || 1));
    this.tokens = {};
    this.commit(createRoom(code, seed, now, scale), now);
    return true;
  }

  async info(): Promise<RoomInfo> {
    const s = this.state;
    if (!s || isAbandoned(s, Date.now())) return { exists: false };
    return { exists: true, phase: s.phase, players: Object.values(s.players).filter((p) => p.role === "player").length };
  }

  // --- WebSocket lifecycle -------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (!this.state || isAbandoned(this.state, Date.now())) {
      return Response.json({ error: "Room not found" }, { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return Response.json({ error: "Room is busy" }, { status: 503 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (this.rateLimited(ws)) return;
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return sendError(ws, "bad_message", parsed.error);
    const msg = parsed.msg;

    if (msg.t === "ping") return send(ws, { t: "pong" });
    if (msg.t === "hello") return this.onHello(ws, msg.name);
    if (msg.t === "resume") return this.onResume(ws, msg.playerId, msg.token);

    const pid = this.attachment(ws).pid;
    if (!pid || !this.state?.players[pid]) return sendError(ws, "not_joined");
    const action = toAction(pid, msg);
    if (!action) return sendError(ws, "bad_message");
    if (msg.t === "leave") {
      // Detach first so the broadcast below doesn't treat this socket as orphaned.
      this.attachment(ws, null);
      this.apply(ws, action);
      send(ws, { t: "bye", reason: "left" });
      ws.close(1000, "left");
      return;
    }
    this.apply(ws, action);
  }

  override async webSocketClose(ws: WebSocket, _code: number, _reason: string, _clean: boolean): Promise<void> {
    this.onSocketGone(ws);
    try {
      ws.close(1000, "closed");
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.onSocketGone(ws);
  }

  override async alarm(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    if (isAbandoned(s, now)) {
      for (const ws of this.ctx.getWebSockets()) {
        send(ws, { t: "bye", reason: "room_closed" });
        ws.close(1000, "room closed");
      }
      this.state = null;
      this.tokens = {};
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    const res = applyAction(s, { type: "tick" }, now);
    if (res.ok) this.commit(res.state, now);
  }

  // --- Handlers --------------------------------------------------------------

  private async onHello(ws: WebSocket, name: string): Promise<void> {
    if (this.attachment(ws).pid) return sendError(ws, "already_joined");
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await sha256(token);
    // --- synchronous from here: re-check after the await ---
    const s = this.state;
    if (!s) return sendError(ws, "room_closed");
    if (this.attachment(ws).pid) return sendError(ws, "already_joined");
    const pid = crypto.randomUUID();
    const now = Date.now();
    const res = applyAction(s, { type: "join", playerId: pid, name }, now);
    if (!res.ok) return sendError(ws, res.error);
    this.tokens[hash] = pid;
    this.attachment(ws, pid);
    send(ws, { t: "welcome", playerId: pid, token, resumed: false });
    this.commit(res.state, now);
  }

  private async onResume(ws: WebSocket, playerId: string, token: string): Promise<void> {
    if (this.attachment(ws).pid) return sendError(ws, "already_joined");
    const hash = await sha256(token);
    // --- synchronous from here ---
    const s = this.state;
    if (!s) return sendError(ws, "room_closed");
    if (this.tokens[hash] !== playerId || !s.players[playerId]) return sendError(ws, "bad_token");
    // One live socket per seat: the newest connection wins.
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws && this.attachment(other).pid === playerId) {
        this.attachment(other, null);
        send(other, { t: "bye", reason: "replaced" });
        other.close(4000, "replaced");
      }
    }
    this.attachment(ws, playerId);
    const now = Date.now();
    send(ws, { t: "welcome", playerId, resumed: true });
    const res = applyAction(s, { type: "connect", playerId }, now);
    if (res.ok) this.commit(res.state, now);
  }

  private onSocketGone(ws: WebSocket): void {
    this.rates.delete(ws);
    const pid = this.attachment(ws).pid;
    this.attachment(ws, null);
    const s = this.state;
    if (!pid || !s?.players[pid]) return;
    const stillHere = this.ctx.getWebSockets().some((o) => o !== ws && this.attachment(o).pid === pid);
    if (stillHere) return;
    const now = Date.now();
    const res = applyAction(s, { type: "disconnect", playerId: pid }, now);
    if (res.ok) this.commit(res.state, now);
  }

  // --- Core ----------------------------------------------------------------------

  private apply(ws: WebSocket, action: EngineAction): boolean {
    const s = this.state;
    if (!s) {
      sendError(ws, "room_closed");
      return false;
    }
    const now = Date.now();
    const res = applyAction(s, action, now);
    if (!res.ok) {
      sendError(ws, res.error);
      return false;
    }
    this.commit(res.state, now);
    return true;
  }

  /** Persist, reschedule and broadcast. Synchronous apart from the alarm write. */
  private commit(next: RoomState, now: number): void {
    this.state = next;
    // Drop credentials for seats that no longer exist.
    for (const [hash, pid] of Object.entries(this.tokens)) {
      if (!next.players[pid]) delete this.tokens[hash];
    }
    this.ctx.storage.kv.put("state", next);
    this.ctx.storage.kv.put("tokens", this.tokens);
    const wake = nextWakeTime(next);
    if (wake === null) void this.ctx.storage.deleteAlarm();
    else void this.ctx.storage.setAlarm(Math.max(wake, now + 50));
    this.broadcast(next, now);
  }

  private broadcast(s: RoomState, now: number): void {
    for (const ws of this.ctx.getWebSockets()) {
      const pid = this.attachment(ws).pid;
      if (!pid) continue;
      if (!s.players[pid]) {
        // Seat was reclaimed (grace expired) — tell the client to rejoin.
        this.attachment(ws, null);
        sendError(ws, "bad_token");
        continue;
      }
      send(ws, { t: "state", view: viewFor(s, pid, now) });
    }
  }

  private attachment(ws: WebSocket, set?: string | null): Attachment {
    if (set !== undefined) {
      const next: Attachment = { pid: set };
      ws.serializeAttachment(next);
      return next;
    }
    return (ws.deserializeAttachment() as Attachment | null) ?? { pid: null };
  }

  private rateLimited(ws: WebSocket): boolean {
    const now = Date.now();
    let r = this.rates.get(ws);
    if (!r || now - r.start > RATE_WINDOW_MS) {
      r = { start: now, count: 0 };
      this.rates.set(ws, r);
    }
    r.count++;
    if (r.count > RATE_HARD_LIMIT) {
      ws.close(1008, "rate limit");
      return true;
    }
    if (r.count > RATE_SOFT_LIMIT) {
      sendError(ws, "rate_limited");
      return true;
    }
    return false;
  }
}

function toAction(playerId: string, msg: ClientMessage): EngineAction | null {
  switch (msg.t) {
    case "answer":
      return { type: "answer", playerId, value: msg.value };
    case "predict":
      return { type: "predict", playerId, value: msg.value };
    case "echo":
      return { type: "echo", playerId, choice: msg.choice };
    case "consent":
      return { type: "consent", playerId, value: msg.value };
    case "start":
      return { type: "start", playerId };
    case "next":
      return { type: "next", playerId };
    case "settings":
      return { type: "settings", playerId, rounds: msg.rounds };
    case "play_again":
      return { type: "play_again", playerId };
    case "leave":
      return { type: "leave", playerId };
    default:
      return null;
  }
}

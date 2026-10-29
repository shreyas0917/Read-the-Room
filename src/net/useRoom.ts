// Room connection hook: one WebSocket per room screen, with resume-token
// authentication, exponential backoff, and snapshot recovery. The server is
// authoritative — this hook only stores the latest personalised view.

import { useCallback, useEffect, useRef, useState } from "react";
import { PROTOCOL_VERSION, type ClientMessage, type ClientView, type ErrorCode, type ServerMessage } from "../../shared/protocol";
import { getRoomInfo } from "../lib/api";
import { clearPendingJoin, loadSession, saveSession } from "../lib/storage";

export type ConnStatus = "connecting" | "open" | "reconnecting" | "not_found" | "closed" | "replaced";

export interface RoomError {
  code: ErrorCode;
  message: string;
  at: number;
}

export interface RoomConnection {
  status: ConnStatus;
  view: ClientView | null;
  /** Server clock minus local clock, in ms. */
  clockOffset: number;
  needsName: boolean;
  joining: boolean;
  nameError: string | null;
  lastError: RoomError | null;
  /** The server runs a different protocol version: this tab should reload. */
  updateAvailable: boolean;
  join: (name: string) => void;
  send: (msg: ClientMessage) => void;
  leave: () => void;
}

const NAME_ERRORS: ErrorCode[] = ["invalid_name", "name_taken", "room_full"];

// Liveness watchdog. A socket can look open while the server has dropped it
// (half-open mobile connections, or an idle socket evicted from a full room),
// so the client checks that the server is still answering.
const PING_EVERY_MS = 25_000;
/** hello/resume must be answered within this. */
const IDENTIFY_TIMEOUT_MS = 6_000;
/** Pongs arrive every PING_EVERY_MS; silence longer than this means the link is dead. */
const SILENCE_TIMEOUT_MS = 45_000;

export function useRoom(code: string, initialName: string | null): RoomConnection {
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [view, setView] = useState<ClientView | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [needsName, setNeedsName] = useState(false);
  const [joining, setJoining] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<RoomError | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingName = useRef<string | null>(initialName);
  const attempts = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const stopped = useRef(false);
  const joined = useRef(false);
  const lastHeard = useRef(0);
  const lastPing = useRef(0);
  const awaiting = useRef<number | null>(null);

  const rawSend = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  /** Sends hello/resume and starts the identify watchdog. */
  const identify = useCallback((ws: WebSocket, msg: ClientMessage) => {
    ws.send(JSON.stringify(msg));
    awaiting.current = Date.now();
  }, []);

  const connectRef = useRef<() => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    if (stopped.current) return;
    setStatus("reconnecting");
    const n = attempts.current++;
    // Every few failures, check whether the room still exists at all.
    if (n > 0 && n % 3 === 0) {
      getRoomInfo(code)
        .then((info) => {
          if (!info.exists) {
            stopped.current = true;
            saveSession(code, null);
            setStatus("not_found");
          }
        })
        .catch(() => {});
    }
    const delay = Math.min(8000, 400 * 2 ** n) * (0.7 + Math.random() * 0.6);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => connectRef.current(), delay);
  }, [code]);

  /** Abandons a socket the server stopped answering and reconnects. */
  const dropSocket = useCallback(
    (ws: WebSocket) => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      awaiting.current = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
      scheduleReconnect();
    },
    [scheduleReconnect],
  );

  const connect = useCallback(() => {
    if (stopped.current) return;
    window.clearTimeout(timer.current);
    const old = wsRef.current;
    if (old && (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING)) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/rooms/${code}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      attempts.current = 0;
      lastHeard.current = Date.now();
      setStatus("open");
      const session = loadSession(code);
      if (session) {
        identify(ws, { t: "resume", playerId: session.playerId, token: session.token });
      } else if (pendingName.current) {
        setJoining(true);
        identify(ws, { t: "hello", name: pendingName.current });
      } else {
        setNeedsName(true);
      }
    };

    ws.onmessage = (ev) => {
      lastHeard.current = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.t) {
        case "welcome":
          awaiting.current = null;
          if (msg.protocol !== undefined && msg.protocol !== PROTOCOL_VERSION) setUpdateAvailable(true);
          joined.current = true;
          if (msg.token) saveSession(code, { playerId: msg.playerId, token: msg.token });
          clearPendingJoin(code);
          pendingName.current = null;
          setNeedsName(false);
          setJoining(false);
          setNameError(null);
          break;
        case "state":
          setView(msg.view);
          setClockOffset(msg.view.serverNow - Date.now());
          break;
        case "error":
          awaiting.current = null;
          if (msg.code === "bad_token") {
            // Seat is gone (left, expired, or room recreated): start fresh.
            saveSession(code, null);
            joined.current = false;
            setView(null);
            if (pendingName.current) identify(ws, { t: "hello", name: pendingName.current });
            else setNeedsName(true);
          } else if (NAME_ERRORS.includes(msg.code) && !joined.current) {
            pendingName.current = null;
            setJoining(false);
            setNeedsName(true);
            setNameError(msg.message);
          } else {
            setLastError({ code: msg.code, message: msg.message, at: Date.now() });
          }
          break;
        case "bye":
          if (msg.reason === "replaced") {
            stopped.current = true;
            setStatus("replaced");
          } else {
            stopped.current = true;
            if (msg.reason === "left") saveSession(code, null);
            setStatus("closed");
          }
          break;
        case "pong":
          break;
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      awaiting.current = null;
      scheduleReconnect();
    };
  }, [code, identify, scheduleReconnect]);
  connectRef.current = connect;

  useEffect(() => {
    stopped.current = false;
    let cancelled = false;
    getRoomInfo(code)
      .then((info) => {
        if (cancelled) return;
        if (!info.exists) {
          saveSession(code, null);
          setStatus("not_found");
        } else connect();
      })
      .catch(() => !cancelled && connect());

    const wake = () => {
      if (document.visibilityState === "visible" && !stopped.current) {
        attempts.current = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    // Keep idle connections (and mobile NATs) alive, and notice dead ones.
    const ping = window.setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (awaiting.current !== null && now - awaiting.current > IDENTIFY_TIMEOUT_MS) return dropSocket(ws);
      if (now - lastHeard.current > SILENCE_TIMEOUT_MS) return dropSocket(ws);
      if (now - lastPing.current >= PING_EVERY_MS) {
        lastPing.current = now;
        rawSend({ t: "ping" });
      }
    }, 1000);

    return () => {
      cancelled = true;
      stopped.current = true;
      window.clearTimeout(timer.current);
      window.clearInterval(ping);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [code, connect, rawSend, dropSocket]);

  const join = useCallback(
    (name: string) => {
      pendingName.current = name;
      setNameError(null);
      setJoining(true);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) identify(ws, { t: "hello", name });
    },
    [identify],
  );

  const leave = useCallback(() => {
    rawSend({ t: "leave" });
    saveSession(code, null);
  }, [code, rawSend]);

  return { status, view, clockOffset, needsName, joining, nameError, lastError, updateAvailable, join, send: rawSend, leave };
}

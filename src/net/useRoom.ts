// Room connection hook: one WebSocket per room screen, with resume-token
// authentication, exponential backoff, and snapshot recovery. The server is
// authoritative — this hook only stores the latest personalised view.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, ClientView, ErrorCode, ServerMessage } from "../../shared/protocol";
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
  join: (name: string) => void;
  send: (msg: ClientMessage) => void;
  leave: () => void;
}

const NAME_ERRORS: ErrorCode[] = ["invalid_name", "name_taken", "room_full"];

export function useRoom(code: string, initialName: string | null): RoomConnection {
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [view, setView] = useState<ClientView | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [needsName, setNeedsName] = useState(false);
  const [joining, setJoining] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<RoomError | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingName = useRef<string | null>(initialName);
  const attempts = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const stopped = useRef(false);
  const joined = useRef(false);

  const rawSend = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

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
      setStatus("open");
      const session = loadSession(code);
      if (session) {
        ws.send(JSON.stringify({ t: "resume", playerId: session.playerId, token: session.token }));
      } else if (pendingName.current) {
        setJoining(true);
        ws.send(JSON.stringify({ t: "hello", name: pendingName.current }));
      } else {
        setNeedsName(true);
      }
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      switch (msg.t) {
        case "welcome":
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
          if (msg.code === "bad_token") {
            // Seat is gone (left, expired, or room recreated): start fresh.
            saveSession(code, null);
            joined.current = false;
            setView(null);
            if (pendingName.current) ws.send(JSON.stringify({ t: "hello", name: pendingName.current }));
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
      timer.current = window.setTimeout(connect, delay);
    };
  }, [code]);

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
    // Keep idle connections (and mobile NATs) alive.
    const ping = window.setInterval(() => rawSend({ t: "ping" }), 25_000);

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
  }, [code, connect, rawSend]);

  const join = useCallback(
    (name: string) => {
      pendingName.current = name;
      setNameError(null);
      setJoining(true);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "hello", name }));
    },
    [],
  );

  const leave = useCallback(() => {
    rawSend({ t: "leave" });
    saveSession(code, null);
  }, [code, rawSend]);

  return { status, view, clockOffset, needsName, joining, nameError, lastError, join, send: rawSend, leave };
}

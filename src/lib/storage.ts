// Browser storage can be unavailable (private mode, blocked cookies). Every
// access is guarded so the game still works, just without resume-on-refresh.

export interface Session {
  playerId: string;
  token: string;
}

const sessionKey = (code: string) => `rtr:session:${code}`;

function safeGet(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

function safeSet(store: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    // ignore
  }
}

const local = () => window.localStorage;
const tab = () => window.sessionStorage;

export function loadSession(code: string): Session | null {
  const raw = safeGet(local, sessionKey(code));
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Session>;
    return typeof s.playerId === "string" && typeof s.token === "string" ? { playerId: s.playerId, token: s.token } : null;
  } catch {
    return null;
  }
}

export function saveSession(code: string, s: Session | null): void {
  safeSet(local, sessionKey(code), s ? JSON.stringify(s) : null);
}

export function loadName(): string {
  return safeGet(local, "rtr:name") ?? "";
}

export function saveName(name: string): void {
  safeSet(local, "rtr:name", name);
}

/** A name chosen on the landing page, used by the room screen until joined. */
export function setPendingJoin(code: string, name: string): void {
  safeSet(tab, `rtr:pending:${code}`, name);
}

export function peekPendingJoin(code: string): string | null {
  return safeGet(tab, `rtr:pending:${code}`);
}

export function clearPendingJoin(code: string): void {
  safeSet(tab, `rtr:pending:${code}`, null);
}

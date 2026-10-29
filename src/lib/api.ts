export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
}

export async function createRoom(): Promise<string> {
  const res = await fetch("/api/rooms", { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string };
  if (!res.ok || !body.code) throw new Error(body.error ?? "Couldn't create a room. Try again.");
  return body.code;
}

export interface RoomInfo {
  exists: boolean;
  phase?: string;
  players?: number;
}

export async function getRoomInfo(code: string): Promise<RoomInfo> {
  const res = await fetch(`/api/rooms/${code}`);
  if (res.status === 400) return { exists: false };
  if (!res.ok) throw new Error("Network error");
  return (await res.json()) as RoomInfo;
}

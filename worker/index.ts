// Front Worker: tiny HTTP router. Static assets (the React app) are served by
// Workers Static Assets; only /api/* reaches this code.
//
//   POST /api/rooms            → { code }            create a room
//   GET  /api/rooms/:code      → { exists, phase, players }
//   GET  /api/rooms/:code/ws   → WebSocket upgrade, forwarded to the room's DO

export { Room } from "./room";

/** No I, L, O (look like 1/0); codes are 4 letters → 23^4 ≈ 280k combinations. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

// Best-effort per-isolate limiter for room creation. Each Room also enforces
// its own per-socket message limits, so this only needs to stop casual abuse.
const CREATE_WINDOW_MS = 60_000;
const CREATE_LIMIT = 10;
const createLog = new Map<string, number[]>();

function allowCreate(ip: string, now: number): boolean {
  const recent = (createLog.get(ip) ?? []).filter((t) => now - t < CREATE_WINDOW_MS);
  if (recent.length >= CREATE_LIMIT) {
    createLog.set(ip, recent);
    return false;
  }
  recent.push(now);
  createLog.set(ip, recent);
  if (createLog.size > 5000) createLog.clear();
  return true;
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  // 256 % 23 bias is negligible for room codes.
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "rooms", code?, "ws"?]
    if (parts[0] !== "api" || parts[1] !== "rooms") return json({ error: "Not found" }, 404);

    if (parts.length === 2) {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const ip = request.headers.get("CF-Connecting-IP") ?? "local";
      if (!allowCreate(ip, Date.now())) return json({ error: "Too many rooms created. Try again in a minute." }, 429);
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = randomCode();
        if (await env.ROOMS.getByName(code).init(code)) return json({ code }, 201);
      }
      return json({ error: "Could not allocate a room code" }, 503);
    }

    const code = (parts[2] ?? "").toUpperCase();
    if (!CODE_RE.test(code)) return json({ error: "Invalid room code" }, 400);
    const stub = env.ROOMS.getByName(code);

    if (parts.length === 3 && request.method === "GET") return json(await stub.info());
    if (parts.length === 4 && parts[3] === "ws") return stub.fetch(request);
    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

// Front Worker: tiny HTTP router. Static assets (the React app) are served by
// Workers Static Assets; only /api/* reaches this code.
//
//   POST /api/rooms            → { code }            create a room
//   GET  /api/rooms/:code      → { exists, phase, players }
//   GET  /api/rooms/:code/ws   → WebSocket upgrade, forwarded to the room's DO

export { Room } from "./room";

/** No I, L, O (look like 1/0); codes are 4 letters → 23^4 ≈ 280k combinations. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

// Best-effort per-isolate, per-IP sliding-window limiters. They stop casual
// abuse (room spam, code enumeration burning the daily request quota); each
// Room also limits messages per socket. Limits are generous because a whole
// classroom can share one IP.
const WINDOW_MS = 60_000;
const LIMITS = { create: 10, lookup: 120 } as const;
const logs = { create: new Map<string, number[]>(), lookup: new Map<string, number[]>() };

function allow(kind: keyof typeof LIMITS, ip: string, now: number): boolean {
  const log = logs[kind];
  const recent = (log.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  const ok = recent.length < LIMITS[kind];
  if (ok) recent.push(now);
  log.set(ip, recent);
  if (log.size > 5000) log.clear();
  return ok;
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  // 256 % 23 bias is negligible for room codes.
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

// Worker responses don't get public/_headers, so set the relevant ones here.
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "rooms", code?, "ws"?]
    if (parts[0] !== "api" || parts[1] !== "rooms") return json({ error: "Not found" }, 404);

    const ip = request.headers.get("CF-Connecting-IP") ?? "local";
    if (parts.length === 2) {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (!allow("create", ip, Date.now())) return json({ error: "Too many rooms created. Try again in a minute." }, 429);
      // Test fixture: a fixed seed makes Echo Round selection reproducible in
      // browser tests. Only honoured when the deployment explicitly enables it
      // (the `test` env in wrangler.jsonc); production ignores ?seed entirely.
      const seedParam = url.searchParams.get("seed");
      const testSeed =
        env.ALLOW_TEST_SEED === "1" && seedParam && /^\d{1,9}$/.test(seedParam)
          ? Number(seedParam)
          : undefined;
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = randomCode();
        if (await env.ROOMS.getByName(code).init(code, testSeed)) return json({ code }, 201);
      }
      return json({ error: "Could not allocate a room code" }, 503);
    }

    const code = (parts[2] ?? "").toUpperCase();
    if (!CODE_RE.test(code)) return json({ error: "Invalid room code" }, 400);
    if (!allow("lookup", ip, Date.now())) return json({ error: "Too many requests. Try again in a minute." }, 429);
    const stub = env.ROOMS.getByName(code);

    if (parts.length === 3 && request.method === "GET") return json(await stub.info());
    if (parts.length === 4 && parts[3] === "ws") return stub.fetch(request);
    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

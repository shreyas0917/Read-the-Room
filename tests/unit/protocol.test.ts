import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, normalizeName, parseClientMessage } from "../../shared/protocol";

const ok = (o: unknown) => parseClientMessage(JSON.stringify(o));

describe("parseClientMessage", () => {
  it("accepts well-formed messages", () => {
    expect(ok({ t: "answer", value: 7 })).toEqual({ ok: true, msg: { t: "answer", value: 7 } });
    expect(ok({ t: "predict", value: 6.3 })).toEqual({ ok: true, msg: { t: "predict", value: 6.3 } });
    expect(ok({ t: "settings", rounds: 12 }).ok).toBe(true);
    expect(ok({ t: "start" }).ok).toBe(true);
    expect(ok({ t: "hello", name: "  Priya  " })).toEqual({ ok: true, msg: { t: "hello", name: "Priya" } });
  });

  it("rejects malformed, oversized, unknown and extra-field messages", () => {
    expect(parseClientMessage("not json").ok).toBe(false);
    expect(parseClientMessage(new ArrayBuffer(4)).ok).toBe(false);
    expect(parseClientMessage("x".repeat(MAX_MESSAGE_BYTES + 1)).ok).toBe(false);
    expect(ok([1, 2]).ok).toBe(false);
    expect(ok({ t: "teleport" }).ok).toBe(false);
    expect(ok({ t: "start", force: true }).ok).toBe(false);
    expect(ok({ t: "answer", value: 7, playerId: "someone-else" }).ok).toBe(false);
    expect(ok({ t: "answer", value: "7" }).ok).toBe(false);
    expect(ok({ t: "answer", value: 7.5 }).ok).toBe(false);
    expect(ok({ t: "predict", value: 6.35 }).ok).toBe(false);
    expect(ok({ t: "predict", value: 0.9 }).ok).toBe(false);
    expect(ok({ t: "settings", rounds: 7 }).ok).toBe(false);
    expect(ok({ t: "resume", playerId: "x", token: "y" }).ok).toBe(false);
  });
});

describe("normalizeName", () => {
  it("trims, collapses whitespace and strips control/format characters", () => {
    expect(normalizeName("  Ana   Maria ")).toBe("Ana Maria");
    expect(normalizeName("Bob\u0000​")).toBe("Bob");
    expect(normalizeName("")).toBeNull();
    expect(normalizeName(42)).toBeNull();
    expect(normalizeName("🦊".repeat(16))).toBe("🦊".repeat(16));
    expect(normalizeName("🦊".repeat(17))).toBeNull();
  });
});

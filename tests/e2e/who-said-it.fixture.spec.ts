import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { applyAction, createRoom, type EngineAction } from "../../shared/engine";
import type { RoomState } from "../../shared/protocol";
import { FIXTURE_URL } from "../../playwright.config";

// Full "Who said it?" flow with four independent browser contexts against a
// local server in the `e2e` Wrangler env (seedable rooms, real timers).
//
// Determinism: the round-3 Echo mode depends only on the room seed, seat
// order and game history — never on the random player ids. So we replay the
// exact planned game through the same shared engine the server runs, find a
// seed whose round 3 is "Who said it?", and create the room with that seed.
//
// The answers make Ben the only consenting player with a unique answer,
// while Dev (who does NOT consent) gives the most extreme answer in both
// rounds: if consent weren't enforced, the "most extreme" preference would
// pick Dev.

test.skip(!!process.env.BASE_URL, "needs the local seedable fixture server");
test.use({ baseURL: FIXTURE_URL });

const NAMES = ["Ana", "Ben", "Cy", "Dev"] as const;
const CONSENT = [true, true, true, false];
const ANSWERS: Record<number, number[]> = { 1: [6, 5, 6, 8], 2: [4, 3, 4, 2] };
const SHOTS = "test-results/screens";

function findSeed(): number {
  const id = (i: number) => `00000000-0000-4000-8000-00000000000${i}`;
  for (let seed = 1; seed < 5000; seed++) {
    let s: RoomState = createRoom("TEST", seed, 0);
    const act = (a: EngineAction) => {
      const r = applyAction(s, a, 0);
      if (!r.ok) throw new Error(`${a.type}: ${r.error}`);
      s = r.state;
    };
    NAMES.forEach((n, i) => act({ type: "join", playerId: id(i), name: n }));
    CONSENT.forEach((c, i) => c && act({ type: "consent", playerId: id(i), value: true }));
    act({ type: "settings", playerId: id(0), rounds: 6 });
    act({ type: "start", playerId: id(0) });
    for (const round of [1, 2]) {
      ANSWERS[round]!.forEach((v, i) => act({ type: "answer", playerId: id(i), value: v }));
      NAMES.forEach((_, i) => act({ type: "predict", playerId: id(i), value: 5 }));
      act({ type: "next", playerId: id(0) });
    }
    const echo = s.current?.echo;
    if (echo?.kind === "who") {
      if (echo.subjectId !== id(1)) throw new Error("fixture broken: subject should be Ben");
      return seed;
    }
  }
  throw new Error("no seed produces Who Said It in round 3");
}

interface Player {
  name: string;
  ctx: BrowserContext;
  page: Page;
  frames: string[];
  token: string | null;
  id: string | null;
}

async function open(browser: Browser, name: string, mobile: boolean): Promise<Player> {
  const ctx = await browser.newContext(
    mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } },
  );
  const page = await ctx.newPage();
  const p: Player = { name, ctx, page, frames: [], token: null, id: null };
  // Record every WebSocket frame the browser receives, across reloads.
  page.on("websocket", (ws) =>
    ws.on("framereceived", (f) => {
      const text = typeof f.payload === "string" ? f.payload : f.payload.toString();
      p.frames.push(text);
      const m = JSON.parse(text) as { t: string; token?: string; playerId?: string };
      if (m.t === "welcome") {
        p.id = m.playerId ?? p.id;
        if (m.token) p.token = m.token;
      }
    }),
  );
  return p;
}

const states = (p: Player) =>
  p.frames.map((f) => JSON.parse(f) as { t: string; view?: Record<string, unknown> }).filter((m) => m.t === "state");

async function answer(page: Page, value: number) {
  await page.getByLabel("Your answer").fill(String(value));
  await page.getByRole("button", { name: /^Lock in/ }).click();
}

async function predict(page: Page, value: number) {
  await page.getByLabel("Predicted average").fill(String(value));
  await page.getByRole("button", { name: /^Predict/ }).click();
}

test("Who said it? with four devices: consent, privacy, decoy, keyboard, reconnects, scoring", async ({ browser, request }) => {
  const seed = findSeed();
  const res = await request.post(`/api/rooms?seed=${seed}`);
  expect(res.status()).toBe(201);
  const { code } = (await res.json()) as { code: string };

  const players: Player[] = [];
  for (let i = 0; i < 4; i++) {
    const p = await open(browser, NAMES[i]!, i > 0);
    players.push(p);
    // Join one at a time so seats match the simulated game.
    await p.page.goto(`/r/${code}`);
    await p.page.getByLabel("Your name").fill(p.name);
    await p.page.getByRole("button", { name: "Join game" }).click();
    await expect(players[0]!.page.locator(".chip", { hasText: p.name })).toBeVisible();
  }
  const [ana, ben, cy, dev] = players as [Player, Player, Player, Player];

  // --- Consent: individual, private, count only ---------------------------------
  for (let i = 0; i < 4; i++) {
    const sw = players[i]!.page.getByRole("switch");
    await expect(sw).toHaveAttribute("aria-checked", "false"); // off by default
    if (CONSENT[i]) {
      await sw.focus();
      await players[i]!.page.keyboard.press("Space"); // keyboard-operable
      await expect(sw).toHaveAttribute("aria-checked", "true");
    }
  }
  for (const p of players) await expect(p.page.getByText("3 of 4 players are on the record")).toBeVisible();
  await expect(dev.page.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  for (const p of players) {
    for (const m of states(p)) {
      const ps = (m.view?.players ?? []) as Record<string, unknown>[];
      expect(ps.every((x) => !("onRecord" in x)), `${p.name} saw someone's consent flag`).toBe(true);
    }
  }
  await ben.page.screenshot({ path: `${SHOTS}/09-consent-phone.png`, fullPage: true });

  // --- Round picker by keyboard: 9 → ← → 6 ---------------------------------------
  const nine = ana.page.getByRole("radio", { name: "9" });
  await nine.focus();
  await ana.page.keyboard.press("ArrowLeft");
  await expect(ana.page.getByRole("radio", { name: "6" })).toHaveAttribute("aria-checked", "true");
  await expect(ana.page.getByRole("radio", { name: "6" })).toBeFocused();
  await expect(dev.page.getByText(/6 rounds/)).toBeVisible();
  await ana.page.getByRole("button", { name: /Start game/ }).click();

  // --- Rounds 1 and 2 --------------------------------------------------------------
  for (const round of [1, 2]) {
    for (const p of players) await expect(p.page.locator(".round-head .eyebrow", { hasText: `Round ${round} of 6` })).toBeVisible();
    await expect(ben.page.getByText("On the record.")).toBeVisible();
    await expect(dev.page.getByText("Secret & anonymous.")).toBeVisible();
    for (let i = 0; i < 4; i++) await answer(players[i]!.page, ANSWERS[round]![i]!);
    for (const p of players) await predict(p.page, 5);
    for (const p of players) await expect(p.page.locator(".reveal__title")).toBeVisible();
    await ana.page.getByRole("button", { name: "Next round" }).click();
  }

  // --- Round 3: Who said it? ---------------------------------------------------------
  for (const p of players) {
    await expect(p.page.locator(".round-head .eyebrow", { hasText: "Round 3 of 6" })).toBeVisible();
    await expect(p.page.locator(".phase-label")).toHaveText("Who said it?");
  }
  const ask = await ana.page.locator("#echo-ask").textContent();
  expect(ask).toMatch(/Someone answered (5|3)\. Who was it\?/); // Ben's unique answers
  for (const p of players) await expect(p.page.locator("#echo-ask")).toHaveText(ask ?? "");

  // Only the subject is told; nobody else can tell from the screen or the wire.
  await expect(ben.page.getByText("Shh, it was you.")).toBeVisible();
  for (const p of [ana, cy, dev]) await expect(p.page.getByText("Shh, it was you.")).toHaveCount(0);
  const noSubjectYet = (p: Player) => {
    for (const m of states(p)) {
      const raw = JSON.stringify(m.view);
      expect(raw.includes('"subjectId"'), `${p.name} received subjectId before reveal`).toBe(false);
      expect(raw.includes('"truth"'), `${p.name} received truth before reveal`).toBe(false);
      expect(raw.includes('"youAreSubject":true'), `${p.name} was told they are the subject`).toBe(false);
    }
  };
  for (const p of [ana, cy, dev]) noSubjectYet(p);
  expect(states(dev).some((m) => JSON.stringify(m.view).includes('"youAreSubject":true'))).toBe(false); // non-consenting never chosen
  // The "locked in" strip treats the subject like everyone else.
  await expect(ana.page.getByText("0/4 locked in")).toBeVisible();
  await ben.page.screenshot({ path: `${SHOTS}/10-who-subject-phone.png`, fullPage: true });
  await ana.page.screenshot({ path: `${SHOTS}/10-who-guesser-desktop.png`, fullPage: true });

  // Ana: keyboard only. Tab lands on the first enabled option (her own is disabled).
  const opt = (p: Player, name: string) => p.page.locator(".option", { hasText: name });
  await expect(opt(ana, "Ana")).toBeDisabled();
  await ana.page.locator("#echo-ask").click(); // sets the sequential focus start point
  await ana.page.keyboard.press("Tab");
  await expect(opt(ana, "Ben")).toBeFocused();
  const outline = await opt(ana, "Ben").evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none"); // visible focus indicator
  await ana.page.keyboard.press("ArrowRight");
  await expect(opt(ana, "Cy")).toBeFocused();
  await expect(opt(ana, "Cy")).toHaveAttribute("aria-checked", "true");
  await ana.page.keyboard.press("ArrowLeft");
  await ana.page.keyboard.press("ArrowLeft"); // skips her own disabled option, wraps to Dev
  await expect(opt(ana, "Dev")).toBeFocused();
  await ana.page.keyboard.press("Home");
  await expect(opt(ana, "Ben")).toBeFocused();
  await ana.page.keyboard.press("Space");
  await expect(opt(ana, "Ben")).toHaveAttribute("aria-checked", "true");
  await ana.page.keyboard.press("Tab");
  await expect(ana.page.getByRole("button", { name: "Lock it in" })).toBeFocused();
  await ana.page.keyboard.press("Enter");
  await expect(ana.page.locator(".locked__label")).toHaveText("Ben");

  // Cy refreshes before picking: same question, still no hint who it is.
  await cy.page.reload();
  await expect(cy.page.locator("#echo-ask")).toHaveText(ask ?? "");
  await expect(cy.page.getByText("Shh, it was you.")).toHaveCount(0);
  noSubjectYet(cy);
  await opt(cy, "Dev").click();
  await cy.page.getByRole("button", { name: "Lock it in" }).click();

  // Ben (the subject) can't pick himself; makes a decoy pick, then refreshes.
  await expect(opt(ben, "Ben")).toBeDisabled();
  await opt(ben, "Cy").click();
  await ben.page.getByRole("button", { name: "Lock it in" }).click();
  await expect(ben.page.locator(".locked__label")).toHaveText("Cy");
  await ben.page.reload();
  await expect(ben.page.locator(".locked__label")).toHaveText("Cy");

  // Dev drops off the network briefly, comes back, then picks.
  await dev.ctx.setOffline(true);
  await expect(ana.page.locator(".strip li").nth(3)).toBeVisible();
  await dev.ctx.setOffline(false);
  await expect(dev.page.locator("#echo-ask")).toHaveText(ask ?? "", { timeout: 15_000 });
  noSubjectYet(dev);
  await opt(dev, "Ana").click();
  await dev.page.getByRole("button", { name: "Lock it in" }).click();

  // --- Reveal --------------------------------------------------------------------------------
  for (const p of players) await expect(p.page.locator(".who-reveal")).toContainText("It was Ben");
  const row = (p: Player, name: string) =>
    p.page.locator(".scores li").filter({ has: p.page.locator(".scores__name", { hasText: new RegExp(`^${name}$`) }) });
  await expect(row(ana, "Ana")).toContainText("+100");
  await expect(row(ana, "Ana")).toContainText("right");
  await expect(row(ana, "Ben")).toContainText("+50"); // fooled Cy and Dev
  await expect(row(ana, "Ben")).toContainText("fooled 2 players");
  await expect(row(ana, "Cy")).toContainText("+0");
  await expect(row(ana, "Dev")).toContainText("+0");
  await ana.page.waitForTimeout(600);
  await ana.page.screenshot({ path: `${SHOTS}/11-who-reveal-desktop.png`, fullPage: true });
  await cy.page.screenshot({ path: `${SHOTS}/11-who-reveal-phone.png`, fullPage: true });

  // The subject's identity appears on the wire only in echo_reveal snapshots.
  for (const p of players) {
    for (const m of states(p)) {
      if (JSON.stringify(m.view).includes('"subjectId":"')) expect(m.view?.phase).toBe("echo_reveal");
    }
  }
  // Nobody ever received anyone else's resume token, or any hidden answers.
  for (const p of players) {
    expect(p.token, `${p.name} got a token`).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const q of players) {
      if (q === p) continue;
      expect(q.frames.some((f) => f.includes(p.token!)), `${q.name} received ${p.name}'s token`).toBe(false);
    }
    for (const m of states(p)) {
      const raw = JSON.stringify(m.view);
      for (const k of ['"answers"', '"predictions"', '"choices"', '"tokens"']) expect(raw.includes(k), `${p.name}: ${k}`).toBe(false);
    }
  }

  for (const p of players) await p.ctx.close();
});

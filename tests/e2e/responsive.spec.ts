import { expect, test, type Page } from "@playwright/test";

// Narrowest common phone (320 px, iPhone SE 1st gen) with maximum-length
// names: play a full 6-round game and fail on any horizontal overflow.

const SHOTS = "test-results/screens";
const LONG_A = "Maximiliana Bloo"; // 16 characters, the limit
const LONG_B = "Bartholomew Quix";

async function noOverflow(page: Page, where: string) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), {
      message: `horizontal overflow on ${where}`,
    })
    .toBeLessThanOrEqual(0);
}

test("320 px phones: no horizontal overflow on any screen, long names included", async ({ browser }) => {
  const opts = { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true };
  const a = await browser.newContext(opts);
  const b = await browser.newContext(opts);
  const A = await a.newPage();
  const B = await b.newPage();

  await A.goto("/");
  await noOverflow(A, "landing");
  await A.getByLabel("Your name").fill(LONG_A);
  await A.getByRole("button", { name: "Create a room" }).click();
  await A.waitForURL(/\/r\/[A-Z]{4}$/);
  const code = A.url().slice(-4);
  await B.goto(`/r/${code}`);
  await noOverflow(B, "join form");
  await B.getByLabel("Your name").fill(LONG_B);
  await B.getByRole("button", { name: "Join game" }).click();
  await expect(A.locator(".chip", { hasText: LONG_B })).toBeVisible();
  for (const p of [A, B]) await noOverflow(p, "lobby");
  await A.screenshot({ path: `${SHOTS}/13-lobby-320.png`, fullPage: true });

  await A.getByRole("radio", { name: "6" }).click();
  await A.getByRole("button", { name: /Start game/ }).click();

  for (let round = 1; round <= 6; round++) {
    for (const p of [A, B]) await expect(p.locator(".round-head .eyebrow", { hasText: `Round ${round} of 6` })).toBeVisible();
    if (round % 3 === 0) {
      for (const p of [A, B]) await noOverflow(p, `echo round ${round}`);
      if (round === 3) await A.screenshot({ path: `${SHOTS}/14-echo-320.png`, fullPage: true });
      for (const p of [A, B]) {
        await p.locator(".options .option:not([disabled])").first().click();
        await p.getByRole("button", { name: "Lock it in" }).click();
      }
      for (const p of [A, B]) await expect(p.locator(".reveal")).toBeVisible();
      for (const p of [A, B]) await noOverflow(p, `echo reveal ${round}`);
    } else {
      for (const p of [A, B]) await noOverflow(p, `answer ${round}`);
      for (const [p, v] of [[A, round + 1], [B, 10 - round]] as const) {
        await p.getByLabel("Your answer").fill(String(v));
        await p.getByRole("button", { name: /^Lock in/ }).click();
      }
      for (const p of [A, B]) await expect(p.getByText("What's the room's average?")).toBeVisible();
      for (const p of [A, B]) await noOverflow(p, `predict ${round}`);
      for (const p of [A, B]) {
        await p.getByLabel("Predicted average").fill("5.5");
        await p.getByRole("button", { name: /^Predict/ }).click();
      }
      for (const p of [A, B]) await expect(p.locator(".reveal__title")).toBeVisible();
      for (const p of [A, B]) await noOverflow(p, `reveal ${round}`);
      if (round === 1) await B.screenshot({ path: `${SHOTS}/15-reveal-320.png`, fullPage: true });
    }
    await A.getByRole("button", { name: /Next round|See final results/ }).click();
  }

  for (const p of [A, B]) await expect(p.getByRole("heading", { name: "Room Report" })).toBeVisible();
  for (const p of [A, B]) await noOverflow(p, "final + report");
  await A.locator(".report__preview summary").click();
  await noOverflow(A, "report preview open");
  await A.screenshot({ path: `${SHOTS}/16-final-320.png`, fullPage: true });
  await a.close();
  await b.close();
});

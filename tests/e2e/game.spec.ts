import { expect, test, type Page } from "@playwright/test";

// Two independent browser contexts (separate storage = separate devices)
// play a complete 6-round game through the real UI.

const SHOTS = "test-results/screens";

async function answer(page: Page, value: number) {
  await page.getByLabel("Your answer").fill(String(value));
  await page.getByRole("button", { name: /^Lock in/ }).click();
}

async function predict(page: Page, value: number) {
  await page.getByLabel("Predicted average").fill(String(value));
  await page.getByRole("button", { name: /^Predict/ }).click();
}

test("two devices create, join and play a full game", async ({ browser }) => {
  const host = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const guest = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const A = await host.newPage();
  const B = await guest.newPage();

  // Landing → create
  await A.goto("/");
  await expect(A.getByRole("heading", { name: /Read the Room/ })).toBeVisible();
  await A.screenshot({ path: `${SHOTS}/01-landing-desktop.png` });
  await A.getByLabel("Your name").fill("Ana");
  await A.getByRole("button", { name: "Create a room" }).click();
  await A.waitForURL(/\/r\/[A-Z]{4}$/);
  const code = A.url().slice(-4);
  await expect(A.getByText("Waiting for at least one more player")).toBeVisible();

  // Invite link → join form on a phone
  await B.goto(`/r/${code}`);
  await expect(B.getByText("You're invited to room")).toBeVisible();
  await B.getByLabel("Your name").fill("Ben");
  await B.getByRole("button", { name: "Join game" }).click();
  await expect(B.getByText(/Waiting for Ana to start/)).toBeVisible();
  await expect(A.locator(".chip", { hasText: "Ben" })).toBeVisible();
  await A.screenshot({ path: `${SHOTS}/02-lobby-desktop.png`, fullPage: true });
  await B.screenshot({ path: `${SHOTS}/02-lobby-phone.png`, fullPage: true });

  await A.getByRole("radio", { name: "6" }).click();
  await expect(B.getByText(/6 rounds/)).toBeVisible();
  await A.getByRole("button", { name: /Start game/ }).click();

  const plan = [
    [3, 7, 5, 5],
    [8, 9, 8.5, 8],
    [1, 10, 4, 6],
    [6, 6, 6, 6.2],
    [2, 4, 3, 3.5],
    [5, 9, 7, 6],
  ] as const;

  for (let r = 0; r < plan.length; r++) {
    const [a, b, pa, pb] = plan[r]!;
    await expect(A.getByText(`Round ${r + 1} of 6`)).toBeVisible();
    await expect(B.getByText(`Round ${r + 1} of 6`)).toBeVisible();
    // Both devices show the same prompt.
    await expect(B.locator(".prompt__text")).toHaveText((await A.locator(".prompt__text").textContent()) ?? "");
    if (r === 0) await B.screenshot({ path: `${SHOTS}/03-answer-phone.png`, fullPage: true });

    await answer(A, a);
    await expect(A.getByText("Locked in. Nobody else can see this.")).toBeVisible();
    await expect(B.getByText("1/2 locked in")).toBeVisible();

    if (r === 2) {
      // Refresh mid-round on the phone: must come back to the same seat.
      await B.reload();
      await expect(B.getByText(`Round ${r + 1} of 6`)).toBeVisible();
    }
    await answer(B, b);

    await expect(A.getByText("What's the room's average?")).toBeVisible();
    if (r === 0) await B.screenshot({ path: `${SHOTS}/04-predict-phone.png`, fullPage: true });
    await predict(A, pa);
    await predict(B, pb);

    const avg = ((a + b) / 2).toFixed(1);
    await expect(A.locator(".reveal__title")).toContainText(avg);
    await expect(B.locator(".reveal__title")).toContainText(avg);
    if (r === 0) {
      await A.waitForTimeout(900); // let the dot animation settle for the screenshot
      await A.screenshot({ path: `${SHOTS}/05-reveal-desktop.png`, fullPage: true });
      await B.screenshot({ path: `${SHOTS}/05-reveal-phone.png`, fullPage: true });
    }
    // Guest can't advance; host can.
    await expect(B.getByRole("button", { name: /Next round|See final results/ })).toHaveCount(0);
    await A.getByRole("button", { name: /Next round|See final results/ }).click();
  }

  await expect(A.locator(".final__winner")).toBeVisible();
  await expect(B.locator(".final__winner")).toHaveText((await A.locator(".final__winner").textContent()) ?? "");
  const scoreA = await A.locator(".standings li").allTextContents();
  const scoreB = await B.locator(".standings li").allTextContents();
  expect(scoreB).toEqual(scoreA);
  await A.screenshot({ path: `${SHOTS}/06-final-desktop.png`, fullPage: true });
  await B.screenshot({ path: `${SHOTS}/06-final-phone.png`, fullPage: true });

  await A.getByRole("button", { name: "Play again with this room" }).click();
  await expect(B.getByText(/Waiting for Ana to start/)).toBeVisible();

  await host.close();
  await guest.close();
});

test("unknown room shows a clear error", async ({ page }) => {
  await page.goto("/r/QQQQ");
  await expect(page.getByRole("heading", { name: "Room not found" })).toBeVisible();
});

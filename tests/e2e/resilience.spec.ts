import { expect, test, type Page } from "@playwright/test";

// Connection resilience and security headers, against the production build.

function cspErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

test("recovers by itself when the server stops answering a socket", async ({ browser, request }) => {
  const { code } = (await (await request.post("/api/rooms")).json()) as { code: string };
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = cspErrors(page);

  // First connection: the browser's messages never reach the server, exactly
  // like a socket the server has silently dropped. Later ones pass through.
  let connections = 0;
  await page.routeWebSocket(/\/api\/rooms\/[A-Z]{4}\/ws$/, (ws) => {
    connections++;
    ws.connectToServer();
    if (connections === 1) ws.onMessage(() => {});
  });

  await page.goto(`/r/${code}`);
  await page.getByLabel("Your name").fill("Sam");
  const t0 = Date.now();
  await page.getByRole("button", { name: "Join game" }).click();
  await expect(page.getByText("Waiting for at least one more player")).toBeVisible({ timeout: 20_000 });
  const took = Date.now() - t0;
  expect(connections, "client reconnected on its own").toBeGreaterThanOrEqual(2);
  expect(took, "noticed the silent socket within the identify timeout (+ backoff)").toBeLessThan(15_000);
  expect(errors).toEqual([]);
  await ctx.close();
});

test("strict security headers don't break a real game (no CSP violations)", async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const A = await a.newPage();
  const B = await b.newPage();
  const errors = [...[A, B].map(cspErrors)];

  const res = await A.goto("/");
  const headers = res?.headers() ?? {};
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");

  await A.getByLabel("Your name").fill("Ana");
  await A.getByRole("button", { name: "Create a room" }).click();
  await A.waitForURL(/\/r\/[A-Z]{4}$/);
  await expect(A.locator(".qr svg")).toBeVisible(); // inline SVG QR still renders under CSP
  await B.goto(A.url());
  await B.getByLabel("Your name").fill("Ben");
  await B.getByRole("button", { name: "Join game" }).click();
  await A.getByRole("radio", { name: "6" }).click();
  await A.getByRole("button", { name: /Start game/ }).click();

  // Round 1 end to end, including "waiting for" and the first-round score key.
  await A.getByLabel("Your answer").fill("3");
  await A.getByRole("button", { name: /^Lock in/ }).click();
  await expect(A.getByText("Waiting for Ben")).toBeVisible();
  await B.getByLabel("Your answer").fill("7");
  await B.getByRole("button", { name: /^Lock in/ }).click();
  for (const p of [A, B]) {
    await p.getByLabel("Predicted average").fill("5");
    await p.getByRole("button", { name: /^Predict/ }).click();
  }
  await expect(A.locator(".score-key")).toContainText("Bullseye");
  await expect(A.locator(".reveal__title")).toContainText("5.0");

  expect(errors.flat()).toEqual([]);
  await a.close();
  await b.close();
});

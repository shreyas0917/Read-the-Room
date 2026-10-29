// Renders showcase/cover.html to showcase/cover.png (1800×1200, 3:2).
//   node showcase/render-cover.mjs
// Refresh showcase/screens/*.png first from `npx playwright test game.spec`
// (copies of test-results/screens/{05-reveal,07-echo,12-report}-phone.png).
import { chromium } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1800, height: 1200 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(here, "cover.html")).href);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(here, "cover.png") });
await browser.close();
console.log("wrote showcase/cover.png");

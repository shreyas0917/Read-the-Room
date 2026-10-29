import { defineConfig } from "@playwright/test";

// E2E runs against the production build served by the Workers runtime, or
// against a deployment when BASE_URL is set (no local server is started).
//
// Specs that need a reproducible Echo Round (tests/e2e/*.fixture.spec.ts)
// run against a second, local-only server in the `e2e` Wrangler env, which
// accepts POST /api/rooms?seed=N. They are skipped when BASE_URL is set.
const external = process.env.BASE_URL;
export const FIXTURE_URL = "http://localhost:5197";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  // Each spec drives 2–4 browser contexts against a local Workers runtime;
  // running spec files in parallel on one machine starved it enough to delay
  // a phase change past 5 s once. Serial runs + 10 s UI expectations (phases
  // last 20 s) keep timing out of the results without loosening assertions.
  workers: 1,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: external ?? "http://localhost:5198", trace: "retain-on-failure" },
  webServer: external
    ? undefined
    : [
        {
          command: "npm run build && npx vite preview --port 5198 --strictPort",
          url: "http://localhost:5198",
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: "npx vite --port 5197 --strictPort",
          url: FIXTURE_URL,
          env: { CLOUDFLARE_ENV: "e2e" },
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ],
});

import { defineConfig } from "@playwright/test";

// E2E runs against the production build served by the Workers runtime, or
// against a deployment when BASE_URL is set (no local server is started).
const external = process.env.BASE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: external ?? "http://localhost:5198", trace: "retain-on-failure" },
  webServer: external
    ? undefined
    : {
        command: "npm run build && npx vite preview --port 5198 --strictPort",
        url: "http://localhost:5198",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});

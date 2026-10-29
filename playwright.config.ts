import { defineConfig } from "@playwright/test";

// E2E runs against the production build served by the Workers runtime.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5198", trace: "retain-on-failure" },
  webServer: {
    command: "npm run build && npx vite preview --port 5198 --strictPort",
    url: "http://localhost:5198",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});

import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so unit tests run in plain Node without the
// Workers runtime: the shared engine is pure and has no Cloudflare imports.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});

import { defineConfig } from "@playwright/test";

/**
 * Console end-to-end tests run against the app as it is started by
 * scripts/start.sh: the web on :3000, the API on :3001, PostGIS, and the
 * synthetic fixtures case seeded by `pnpm --filter @scout/db run seed:v2`.
 * Nothing is started here; a test that finds no app skips with the reason.
 * One worker, because the review queue test records a real adjudication.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env["SCOUT_WEB_URL"] ?? "http://localhost:3000",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});

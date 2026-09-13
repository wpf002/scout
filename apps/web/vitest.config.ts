import { defineConfig } from "vitest/config";

/**
 * Unit tests only. The Playwright specs under e2e/ use their own runner and
 * a running app; vitest must not collect them.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
  },
});

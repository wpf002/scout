import { defineConfig } from "vitest/config";

/**
 * Tests get their own database.
 *
 * Without this they inherited whatever `DATABASE_URL` was in the shell, which
 * in practice was the development one — so a full run left sixty test cases in
 * the case dropdown, and results depended on what a previous run had left
 * behind. A suite whose answer changes with the state of your dev database is
 * not a gate.
 *
 * The URL is derived from the development one rather than configured
 * separately, so there is nothing to keep in sync: same host, same credentials,
 * a different database name. Override with `SCOUT_TEST_DATABASE_URL` when the
 * test database belongs somewhere else entirely.
 */
function testDatabaseUrl(): string {
  const override = process.env["SCOUT_TEST_DATABASE_URL"];
  if (override !== undefined && override !== "") return override;

  const dev = process.env["DATABASE_URL"];
  if (dev === undefined || dev === "") return "";

  const url = new URL(dev);
  url.pathname = `${url.pathname.replace(/\/$/, "")}_test`;
  return url.toString();
}

export default defineConfig({
  test: {
    globalSetup: ["./src/test/database.ts"],
    setupFiles: ["./src/test/network.ts"],
    env: {
      DATABASE_URL: testDatabaseUrl(),
      // The suite asserts that out-of-scope subjects are refused. Development
      // deliberately runs with the gate open, and inheriting that setting made
      // twenty-five tests fail for a reason that was not a defect.
      SCOUT_AUTHORIZE_ALL: "false",
      SCOUT_AUTH_REQUIRED: "false",

      // No live keys. The suite is written against adapters that report inert,
      // which is deterministic and instant; with real keys the same tests make
      // real calls to Shodan and Censys and time out at five seconds. Tests
      // that reach the internet are not tests.
      HIBP_API_KEY: "",
      HUNTER_API_KEY: "",
      SHODAN_API_KEY: "",
      CENSYS_API_KEY: "",
      OTX_API_KEY: "",
      INTELX_API_KEY: "",
      OPENSANCTIONS_API_KEY: "",
      URLSCAN_API_KEY: "",
      SECURITYTRAILS_API_KEY: "",
    },
    // The suite shares one database, so files cannot run against each other.
    fileParallelism: false,

    // The sweep runs a dozen adapters in one request. Even with the network
    // stubbed that is more than five seconds of parsing and database writes,
    // and the default timeout turned a slow test into a failing one.
    testTimeout: 30_000,
  },
});

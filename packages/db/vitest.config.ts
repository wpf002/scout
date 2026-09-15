import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
/**
 * `DATABASE_URL` from the repo's .env.
 *
 * The app loads .env at startup; vitest does not, so `pnpm test` ran with an
 * empty URL and the whole db suite failed on "You must provide a nonempty URL"
 * — a failure that looked like a broken database rather than a missing
 * variable. Read here so the suite works from a clean shell.
 */
function envFileUrl(): string {
  for (const candidate of ["../../.env", "../../../.env"]) {
    const path = resolve(__dirname, candidate);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      return (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

function testDatabaseUrl(): string {
  const override = process.env["SCOUT_TEST_DATABASE_URL"];
  if (override !== undefined && override !== "") return override;

  const fromShell = process.env["DATABASE_URL"];
  const dev = fromShell !== undefined && fromShell !== "" ? fromShell : envFileUrl();
  if (dev === "") return "";

  const url = new URL(dev);
  // Idempotent. This runs once for the main process and once for the workers'
  // env block; the second pass must not turn scout_test into scout_test_test.
  if (!url.pathname.endsWith("_test")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}_test`;
  }
  return url.toString();
}

// `test.env` reaches the test workers only. globalSetup runs in the main
// process, so without this line it migrated whichever database the shell had,
// which was the development one: the test database was never created, and the
// audit tests that could connect left "cascade check" cases in the real case
// list. Setting it here reaches both.
process.env["DATABASE_URL"] = testDatabaseUrl();

export default defineConfig({
  test: {
    globalSetup: ["./src/test/database.ts"],
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

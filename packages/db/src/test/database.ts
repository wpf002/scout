import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Brings the test database up to the current schema before the suite runs.
 *
 * `prisma migrate deploy` creates the database when it is missing, so there is
 * no separate CREATE step and nothing that needs `psql` on PATH — which is not
 * a given, since Homebrew's postgresql is keg-only and a correctly installed
 * Mac has no psql anywhere PATH can see.
 *
 * Migrating rather than dropping and recreating is deliberate: a fresh database
 * every run turns a seven-second suite into a slow one, and the tests already
 * clean up after themselves within a run.
 */
export async function setup(): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (url === undefined || url === "") {
    // Tests that need a database skip themselves when this is absent, which is
    // the right behaviour on a machine with no Postgres.
    return;
  }

  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

  try {
    execFileSync(
      "pnpm",
      ["--filter", "@scout/db", "exec", "prisma", "migrate", "deploy"],
      {
        cwd: root,
        // Capture rather than ignore: a swallowed setup failure told CI only
        // "command failed", with the reason on a discarded stream. On failure
        // the captured output is attached to the thrown error.
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: url },
      },
    );
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`prisma migrate deploy failed against ${url}\n${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message ?? ""}`);
  }
}

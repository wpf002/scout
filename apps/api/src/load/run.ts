import { writeFileSync } from "node:fs";
import { prisma } from "@scout/db";

import { clean, generate } from "./generate.js";
import { measureQueries } from "./measure.js";
import { cleanResolveSubset, seedResolveSubset } from "./resolve-subset.js";

/**
 * The Phase 11 load test.
 *
 *   pnpm --filter @scout/api exec tsx src/load/run.ts --observations 1000000 --entities 100000 --edges 150000 --resolve 20000
 *   pnpm --filter @scout/api exec tsx src/load/run.ts --measure-only
 *   pnpm --filter @scout/api exec tsx src/load/run.ts --clean
 *
 * Generation and graph timings run in this process against DATABASE_URL.
 * The resolution timing goes through the API on :3001 and the resolution
 * service on :8100, so both must be up for it; without them it is skipped
 * and the report says so. Map frame rate is measured by the Playwright
 * spec apps/web/e2e/load.spec.ts, not here.
 */

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const num = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const log = (line: string) => process.stdout.write(`[load] ${line}\n`);

async function timeResolution(caseId: string): Promise<{ seconds: number; entities: number; pairs: number } | { skipped: string }> {
  const api = process.env["SCOUT_API_URL"] ?? "http://127.0.0.1:3001";
  try {
    const up = await fetch(`${api}/v2/collectors`, { signal: AbortSignal.timeout(3_000) });
    if (!up.ok) return { skipped: `API answered ${up.status}` };
  } catch {
    return { skipped: "API on :3001 not reachable; start the app to time resolution" };
  }
  const t = performance.now();
  const r = await fetch(`${api}/v2/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ caseId, entityKind: "PERSON" }), signal: AbortSignal.timeout(3_600_000) });
  const seconds = (performance.now() - t) / 1000;
  if (!r.ok) return { skipped: `resolve answered ${r.status}: ${(await r.text()).slice(0, 200)}` };
  const body = (await r.json()) as { counts: { entities: number }; runId: string };
  const run = await prisma.resolutionRun.findUnique({ where: { id: body.runId } });
  return { seconds: Math.round(seconds * 10) / 10, entities: body.counts.entities, pairs: run?.pairsEvaluated ?? 0 };
}

async function main(): Promise<void> {
  if (flag("clean")) {
    await cleanResolveSubset();
    await clean(log);
    log("clean");
    return;
  }
  const report: Record<string, unknown> = { at: new Date().toISOString(), node: process.version };
  if (flag("resolve-only")) {
    const resolveN = num("resolve", 20_000);
    const caseId = await seedResolveSubset(resolveN, log);
    report["resolution"] = { observations: resolveN, ...(await timeResolution(caseId)) };
    log(`resolution: ${JSON.stringify(report["resolution"])}`);
    const out = args[args.indexOf("--report") + 1];
    writeFileSync(args.includes("--report") && out !== undefined ? out : "load-report.json", JSON.stringify(report, null, 2));
    return;
  }
  if (!flag("measure-only")) {
    const observations = num("observations", 1_000_000);
    const entities = num("entities", 100_000);
    const edges = num("edges", Math.round(entities * 1.5));
    log(`generating ${observations.toLocaleString("en-US")} observations, ${entities.toLocaleString("en-US")} entities, ${edges.toLocaleString("en-US")} edges`);
    report["generate"] = await generate({ observations, entities, edges, log });
    const resolveN = num("resolve", 20_000);
    if (resolveN > 0) {
      const caseId = await seedResolveSubset(resolveN, log);
      report["resolution"] = { observations: resolveN, ...(await timeResolution(caseId)) };
      log(`resolution: ${JSON.stringify(report["resolution"])}`);
    }
  }
  report["queries"] = await measureQueries(num("iterations", 200), log);
  const size = await prisma.$queryRaw<Array<{ size: string }>>`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`;
  report["databaseSize"] = size[0]?.size ?? null;
  const out = args[args.indexOf("--report") + 1];
  const path = args.includes("--report") && out !== undefined ? out : "load-report.json";
  writeFileSync(path, JSON.stringify(report, null, 2));
  log(`report written to ${path}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

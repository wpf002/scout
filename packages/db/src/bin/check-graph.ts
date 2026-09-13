import { checkGraphConsistency } from "../fusion.js";
import { prisma } from "../client.js";

/**
 * The consistency job. Exits non-zero when the graph disagrees with itself,
 * so it can run from cron or CI and fail loudly.
 *
 *   pnpm graph:check
 */
const report = await checkGraphConsistency();
for (const [name, ids] of Object.entries(report)) {
  if (Array.isArray(ids) && ids.length > 0) {
    console.log(`${name}: ${ids.length}`);
    for (const id of ids.slice(0, 20)) console.log(`  ${id}`);
  }
}
console.log(report.clean ? "graph: consistent" : "graph: INCONSISTENT");
await prisma.$disconnect();
process.exit(report.clean ? 0 : 1);

import { prisma, edgesAsOf } from "@scout/db";
import { ScopeContext } from "@scout/scope";

import { neighbors, pathBetween, timelineForEntity } from "../v2/graph.js";
import { LOAD_AUTHORIZATION_ID } from "./generate.js";

/** p50 / p95 / max of a list of millisecond timings. */
export function percentiles(ms: readonly number[]): { n: number; p50: number; p95: number; max: number; mean: number } {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted[sorted.length - 1] ?? 0), mean: round(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)) };
}
const round = (n: number) => Math.round(n * 10) / 10;

export interface QueryTimings {
  entities: number;
  edges: number;
  neighbors1: ReturnType<typeof percentiles>;
  neighbors2: ReturnType<typeof percentiles>;
  path4: ReturnType<typeof percentiles>;
  timeline: ReturnType<typeof percentiles>;
  edgesAsOf: ReturnType<typeof percentiles>;
}

/**
 * Graph reads at scale, through the same functions the routes call, with
 * the load authorization's scope context. Each query runs `iterations`
 * times on random entities; the first few are warm-up and are dropped.
 */
export async function measureQueries(iterations = 200, log: (line: string) => void = () => undefined): Promise<QueryTimings> {
  const auth = await prisma.authorization.findUniqueOrThrow({ where: { id: LOAD_AUTHORIZATION_ID } });
  const ctx = ScopeContext.build({ authorization: auth, operator: "load-test", now: new Date() });
  const entities = await prisma.entity.count({ where: { id: { startsWith: "ent_load_" } } });
  const edges = await prisma.entityEdge.count({ where: { authorizationId: LOAD_AUTHORIZATION_ID } });
  const random = () => `ent_load_${Math.floor(Math.random() * entities)}`;
  const now = new Date();
  const warm = 10;

  const time = async (name: string, fn: () => Promise<unknown>) => {
    const samples: number[] = [];
    for (let i = 0; i < iterations + warm; i += 1) {
      const t = performance.now();
      await fn();
      if (i >= warm) samples.push(performance.now() - t);
    }
    const p = percentiles(samples);
    log(`${name}: p50 ${p.p50} ms, p95 ${p.p95} ms, max ${p.max} ms`);
    return p;
  };

  return {
    entities,
    edges,
    neighbors1: await time("neighbors hops=1", () => neighbors({ ctx, entityId: random(), hops: 1, asOf: now, knownAs: now })),
    neighbors2: await time("neighbors hops=2", () => neighbors({ ctx, entityId: random(), hops: 2, asOf: now, knownAs: now })),
    path4: await time("path maxHops=4", () => pathBetween({ ctx, from: random(), to: random(), maxHops: 4, asOf: now, knownAs: now })),
    timeline: await time("timeline", () => timelineForEntity({ ctx, entityId: random(), asOf: now, knownAs: now })),
    edgesAsOf: await time("edgesAsOf random moment", () => edgesAsOf(new Date(Date.UTC(2026, 5, 1) + Math.random() * 90 * 86_400_000), { authorizationId: LOAD_AUTHORIZATION_ID, entityIds: [random(), random(), random()] })),
  };
}

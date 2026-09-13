import { prisma } from "@scout/db";
import {
  executePlan,
  modelClientFromEnv,
  planQuestion,
  ReasonRefusal,
  synthesizeByRules,
  synthesizeWithModel,
  type Answer,
  type ModelClient,
  type Operations,
  type QueryPlan,
} from "@scout/reason";
import type { ScopeContext } from "@scout/scope";

import { listRunnable } from "./collectors/index.js";
import { coLocationWindow, neighbors, pathBetween, timelineForEntity, visibleEntities } from "./graph.js";

/**
 * The reasoning layer's host side: the pre-authorized operations over the
 * real graph, and the one function that takes a question through plan,
 * execution and synthesis. Each operation is the same code the graph routes
 * run, with the same scope checks; the planner never sees the database and
 * the executor never sees a query string.
 */

let client: ModelClient | null | undefined;
function modelClient(): ModelClient | null {
  if (client === undefined) client = modelClientFromEnv(process.env);
  return client;
}

/** Test seam: forget the cached client so a changed environment is read again. */
export function resetModelClient(): void {
  client = undefined;
}

export function operationsFor(ctx: ScopeContext, now: Date): Operations {
  return {
    async findEntities({ text, kind, limit }) {
      const needle = text.trim().toLowerCase();
      const rows = await prisma.entity.findMany({
        where: {
          resolutionRun: { authorizationId: ctx.authorizationId },
          members: { some: { supersededAt: null } },
          ...(kind === undefined ? {} : { kind: kind as never }),
          OR: [
            { canonicalLabel: { contains: needle, mode: "insensitive" } },
            { members: { some: { supersededAt: null, observation: { identifiers: { some: { normalizedValue: needle } } } } } },
          ],
        },
        select: { id: true, canonicalLabel: true },
        orderBy: [{ canonicalLabel: "asc" }],
        take: limit * 4,
      });
      // Exact label first, then the rest; and only what the scope check admits.
      const ordered = [...rows].sort((a, b) => Number(b.canonicalLabel.toLowerCase() === needle) - Number(a.canonicalLabel.toLowerCase() === needle));
      const visible = await visibleEntities(ctx, now, ordered.map((r) => r.id));
      return ordered.map((r) => visible.get(r.id)).filter((n): n is NonNullable<typeof n> => n !== undefined).slice(0, limit);
    },
    async neighbors({ entityId, hops, asOf }) {
      const r = await neighbors({ ctx, entityId, hops, asOf, knownAs: now });
      return { root: r.root, nodes: r.nodes, edges: r.edges, truncated: r.truncated };
    },
    async pathBetween({ from, to, maxHops, asOf }) {
      const r = await pathBetween({ ctx, from, to, maxHops, asOf, knownAs: now });
      return { found: r.found, hops: r.hops, nodes: r.nodes, edges: r.edges };
    },
    async coLocation({ entityId, from, to }) {
      return coLocationWindow({ ctx, entityId, from, to });
    },
    async timeline({ entityId, asOf }) {
      const r = await timelineForEntity({ ctx, entityId, asOf, knownAs: now });
      return { entity: r.entity, events: r.events };
    },
    async sourcesConsulted() {
      const consulted = await prisma.observation.groupBy({
        by: ["sourceId"],
        where: { authorizationId: ctx.authorizationId },
        _count: { _all: true },
        _max: { observedAt: true },
      });
      const ids = [...new Set([...listRunnable().map((c) => c.id), ...consulted.map((c) => c.sourceId)])].sort();
      return ids.map((sourceId) => {
        const hit = consulted.find((c) => c.sourceId === sourceId);
        return { sourceId, observations: hit?._count._all ?? 0, lastObservedAt: hit?._max.observedAt ?? null };
      });
    },
  };
}

export interface Asked {
  question: string;
  plan: QueryPlan | null;
  plannedBy: "rules" | "model" | null;
  shape: string | null;
  cost: number | null;
  trace: Array<{ id: string; op: string; nodes: number; edges: number; events: number; sources: number }>;
  answer: Answer;
}

export async function ask(input: { ctx: ScopeContext; operator: string; question: string; now?: Date }): Promise<Asked> {
  const now = input.now ?? new Date();
  const { ctx, operator, question } = input;
  const model = modelClient();
  let plan: QueryPlan | null = null;
  let plannedBy: Asked["plannedBy"] = null;
  let shape: string | null = null;
  let cost: number | null = null;
  const trace: Asked["trace"] = [];
  let answer: Answer;
  try {
    const planned = await planQuestion(question, { now, authorizationReference: ctx.reference }, model);
    plan = planned.plan;
    plannedBy = planned.plannedBy;
    shape = planned.shape;
    const execution = await executePlan(plan, operationsFor(ctx, now), ctx, now);
    cost = execution.cost;
    for (const r of execution.results) trace.push({ id: r.id, op: r.op, nodes: r.nodes.length, edges: r.edges.length, events: r.events.length, sources: r.coverage.length });
    answer = model === null ? synthesizeByRules(plan, execution, ctx.reference) : await synthesizeWithModel(plan, execution, ctx.reference, model);
  } catch (caught) {
    if (!(caught instanceof ReasonRefusal)) throw caught;
    answer = { status: "refused", text: caught.refusal.message, claims: [], citations: [], refusal: caught.refusal, synthesizedBy: null };
  }

  // A question is a read of everything it cited, and a refusal is a read
  // that returned nothing; both are in the access log with the question.
  await prisma.accessLog.create({
    data: {
      actor: operator,
      authorizationId: ctx.authorizationId,
      action: "read",
      targetType: "Reason",
      targetIds: answer.citations,
      queryText: question,
      resultCount: answer.claims.length,
    },
  });
  return { question, plan, plannedBy, shape, cost, trace, answer };
}

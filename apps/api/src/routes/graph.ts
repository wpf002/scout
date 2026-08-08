import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  applyMerges,
  buildGraph,
  extractAll,
  suggestMerges,
  summarizeCase,
  type FindingInput,
} from "@scout/graph";
import { prisma, recordAuditEvent } from "@scout/db";
import { operatorOf } from "../auth.js";
import { badRequest, notFound } from "../errors.js";

const mergeSchema = z.object({
  /** The entity key to keep, and the one to fold into it. */
  winningKey: z.string().min(1),
  losingKey: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
  /**
   * Merging asserts that two records describe one thing. Nothing here is
   * inferred from a score, so the assertion has to be made explicitly.
   */
  confirm: z.literal(true, {
    errorMap: () => ({
      message:
        "confirm must be true — merging asserts two entities are the same thing.",
    }),
  }),
});

const dismissSchema = z.object({ suggestionId: z.string().min(1) });

async function loadCase(caseId: string) {
  const record = await prisma.case.findUnique({ where: { id: caseId } });
  if (record === null) throw notFound(`Case ${caseId} does not exist.`);
  return record;
}

async function graphFor(caseId: string) {
  const [findings, merges, dismissals] = await Promise.all([
    prisma.finding.findMany({
      where: { caseId },
      orderBy: { observedAt: "asc" },
    }),
    prisma.entityMerge.findMany({ where: { caseId } }),
    prisma.mergeDismissal.findMany({ where: { caseId } }),
  ]);

  const inputs: FindingInput[] = findings.map((finding) => ({
    id: finding.id,
    sourceId: finding.sourceId,
    queryTerm: finding.queryTerm,
    queryKind: finding.queryKind.toLowerCase() as FindingInput["queryKind"],
    observedAt: finding.observedAt.toISOString(),
    title: finding.title,
    summary: finding.summary,
    data: finding.data,
  }));

  const raw = buildGraph(extractAll(inputs));
  const merged = applyMerges(
    raw,
    new Map(merges.map((m) => [m.losingKey, m.winningKey])),
  );

  const dismissed = new Set(dismissals.map((d) => d.suggestionId));
  const suggestions = suggestMerges(merged).filter(
    (suggestion) => !dismissed.has(suggestion.id),
  );

  return { inputs, graph: merged, suggestions, merges };
}

export async function registerGraphRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * GET /cases/:id/graph — the entity graph for a case.
   *
   * Recomputed from findings on every read rather than stored. A stored graph
   * would be a second copy of the truth, free to drift from the findings it
   * claims to summarize; recomputing means the graph is always exactly what
   * the evidence supports. Only operator decisions — confirmed merges and
   * dismissed suggestions — are persisted, because those are judgements that
   * cannot be re-derived.
   */
  app.get<{ Params: { id: string } }>("/cases/:id/graph", async (request) => {
    await loadCase(request.params.id);
    const { inputs, graph, suggestions } = await graphFor(request.params.id);
    const summary = await summarizeCase(graph, inputs, null);

    return {
      caseId: request.params.id,
      entities: graph.entities,
      links: graph.links,
      totals: {
        entities: graph.entities.length,
        links: graph.links.length,
        /** Entities more than one source agreed on. */
        corroborated: graph.corroborated,
        sources: new Set(inputs.map((f) => f.sourceId)).size,
        findings: inputs.length,
      },
      /** Proposed merges awaiting a decision. Never applied automatically. */
      suggestions,
      summary,
    };
  });

  /** POST /cases/:id/graph/merge — confirm that two entities are one. */
  app.post<{ Params: { id: string } }>(
    "/cases/:id/graph/merge",
    async (request) => {
      const body = mergeSchema.parse(request.body);
      await loadCase(request.params.id);

      if (body.winningKey === body.losingKey) {
        throw badRequest("An entity cannot be merged into itself.");
      }

      const { graph } = await graphFor(request.params.id);
      const known = new Set(graph.entities.map((entity) => entity.key));
      for (const key of [body.winningKey, body.losingKey]) {
        if (!known.has(key)) {
          throw badRequest(`No entity "${key}" in this case's graph.`);
        }
      }

      const merge = await prisma.entityMerge.upsert({
        where: {
          caseId_losingKey: {
            caseId: request.params.id,
            losingKey: body.losingKey,
          },
        },
        create: {
          caseId: request.params.id,
          losingKey: body.losingKey,
          winningKey: body.winningKey,
          reason: body.reason,
          confirmedBy: operatorOf(request),
        },
        update: {
          winningKey: body.winningKey,
          reason: body.reason,
          confirmedBy: operatorOf(request),
        },
      });

      // Asserting two records describe one person is a judgement about a
      // person, so it belongs in the case record next to the queries.
      await recordAuditEvent({
        caseId: request.params.id,
        action: "graph.merged",
        actor: operatorOf(request),
        detail: {
          winningKey: body.winningKey,
          losingKey: body.losingKey,
          reason: body.reason,
        },
      });

      return merge;
    },
  );

  /** DELETE /cases/:id/graph/merge/:losingKey — undo a merge. */
  app.delete<{ Params: { id: string; losingKey: string } }>(
    "/cases/:id/graph/merge/:losingKey",
    async (request, reply) => {
      await loadCase(request.params.id);
      const losingKey = decodeURIComponent(request.params.losingKey);

      const existing = await prisma.entityMerge.findUnique({
        where: { caseId_losingKey: { caseId: request.params.id, losingKey } },
      });
      if (existing === null) throw notFound("No such merge on this case.");

      await prisma.entityMerge.delete({ where: { id: existing.id } });
      await recordAuditEvent({
        caseId: request.params.id,
        action: "graph.merge-undone",
        actor: operatorOf(request),
        detail: { losingKey, winningKey: existing.winningKey },
      });

      return reply.status(204).send();
    },
  );

  /** POST /cases/:id/graph/dismiss — stop offering a suggestion. */
  app.post<{ Params: { id: string } }>(
    "/cases/:id/graph/dismiss",
    async (request) => {
      const body = dismissSchema.parse(request.body);
      await loadCase(request.params.id);

      const dismissal = await prisma.mergeDismissal.upsert({
        where: {
          caseId_suggestionId: {
            caseId: request.params.id,
            suggestionId: body.suggestionId,
          },
        },
        create: {
          caseId: request.params.id,
          suggestionId: body.suggestionId,
          dismissedBy: operatorOf(request),
        },
        update: { dismissedBy: operatorOf(request) },
      });

      return dismissal;
    },
  );
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { subjectSchema } from "@scout/sources";
import {
  actionClassSchema,
  sourceClassSchema,
} from "@scout/scope";
import {
  fusionEntityKindSchema,
} from "@scout/fusion";
import {
  positionsOf,
  prisma,
  recordAuditEvent,
  toScopeEntry,
} from "@scout/db";
import { HttpError, badRequest, notFound } from "../errors.js";
import { operatorOf } from "../auth.js";
import { scopeContextForCase } from "../v2/scope.js";
import { runCollection } from "../v2/collect.js";
import { agentTick, approveProposal, createMonitor, disableMonitor, executeProposal, monitorSchema, proposalSchema, propose, rejectProposal } from "../agent/index.js";
import { ask } from "../v2/reason.js";
import { objectStore, TILES_BUCKET } from "../v2/storage.js";
import { compare, compareSchema, createGallery, enroll, enrollSchema, gallerySchema, recognitionEnabled, revokeEnrollment } from "../v2/recognition.js";
import { runResolution } from "../v2/resolution.js";
import { deriveLinks } from "../v2/links.js";
import { modelClientFromEnv, parseJsonReply } from "@scout/reason";
import { coLocationClusters, coLocationWindow, neighbors, pathBetween, timelineForEntity, visibleEntities } from "../v2/graph.js";
import { checkGraphConsistency, edgesAsOf, observationDensity, observationIdsInBox } from "@scout/db";
import {
  isConfigured,
  listRunnable,
} from "../v2/collectors/index.js";

/**
 * v2 routes: the authorization a case runs under, collection, and reading
 * what was collected.
 *
 * Every handler gets its scope context from the case's authorization row and
 * nothing else. There is no header, flag or query parameter that widens it.
 * Reads write an AccessLog row; collections write an AuditEvent. Both carry
 * ids, never payloads.
 */

const createAuthorizationSchema = z.object({
  issuedBy: z.string().trim().min(1).max(500),
  sourceClasses: z.array(sourceClassSchema).min(1),
  actionClasses: z.array(actionClassSchema).min(1),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date(),
  /** Empty means any kind. */
  entityKinds: z.array(fusionEntityKindSchema).optional(),
  /** An authorization is an assertion; the caller makes it explicitly. */
  confirmAuthorized: z.literal(true, {
    errorMap: () => ({
      message: "confirmAuthorized must be true — creating an authorization asserts that it was actually granted.",
    }),
  }),
});

const revokeSchema = z.object({ reason: z.string().trim().min(1).max(1000) });

const collectSchema = z.object({
  caseId: z.string().min(1),
  collectorId: z.string().min(1),
  subject: subjectSchema.optional(),
  /** Collector-specific parameters (a bounding box, a time window, a consent record). Each collector validates its own. */
  params: z.record(z.string(), z.unknown()).optional(),
});

const resolveSchema = z.object({
  caseId: z.string().min(1),
  entityKind: fusionEntityKindSchema,
});

const entitiesQuery = z.object({
  caseId: z.string().min(1),
  kind: fusionEntityKindSchema.optional(),
  /** A label fragment, matched without case. The server's find box for a case too big to list. */
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const bboxParam = z
  .string()
  .regex(/^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/)
  .transform((v) => v.split(",").map(Number) as [number, number, number, number])
  .refine(([w, s, e, n]) => e > w && n > s && w >= -180 && e <= 180 && s >= -90 && n <= 90, "bbox is west,south,east,north");

const adjudicateSchema = z.object({
  caseId: z.string().min(1),
  leftObservationId: z.string().min(1),
  rightObservationId: z.string().min(1),
  decision: z.enum(["MATCH", "NON_MATCH", "INDETERMINATE"]),
  note: z.string().trim().min(1).max(2000),
});

const deriveSchema = z.object({
  caseId: z.string().min(1),
  radiusM: z.coerce.number().int().min(10).max(50_000).optional(),
  windowMinutes: z.coerce.number().int().min(1).max(1_440).optional(),
});

const asOfQuery = z.object({
  caseId: z.string().min(1),
  /** Valid time: what held then. Defaults to now. */
  asOf: z.coerce.date().optional(),
  /** Knowledge time: what Scout knew by then. Defaults to now; pass the same
   * instant as asOf for the strict "exactly as it was known at T". */
  knownAs: z.coerce.date().optional(),
});

const observationsQuery = z.object({
  caseId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(2_000).default(100),
  raw: z.enum(["true", "false"]).default("false"),
  /** With a box the read is a window onto the map: positioned observations inside it, newest first. */
  bbox: bboxParam.optional(),
  asOf: z.coerce.date().optional(),
});

function serializeAuthorization(row: {
  id: string; reference: string; issuedBy: string; boundary: unknown;
  sourceClasses: string[]; actionClasses: string[]; validFrom: Date; validUntil: Date;
  revokedAt: Date | null; revokedBy: string | null; revokedReason: string | null;
  createdAt: Date; createdBy: string;
}) {
  const now = Date.now();
  const status =
    row.revokedAt !== null ? "revoked"
    : now < row.validFrom.getTime() ? "not-started"
    : now >= row.validUntil.getTime() ? "expired"
    : "active";
  return { ...row, status };
}

export async function registerV2Routes(app: FastifyInstance): Promise<void> {
  // ── authorization ──────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>("/cases/:id/authorization", async (request) => {
    const record = await prisma.case.findUnique({
      where: { id: request.params.id },
      include: { authorization: true },
    });
    if (record === null) throw notFound(`Case ${request.params.id} does not exist.`);
    return {
      caseId: record.id,
      authorization: record.authorization === null ? null : serializeAuthorization(record.authorization),
    };
  });

  app.post<{ Params: { id: string } }>("/cases/:id/authorization", async (request, reply) => {
    const body = createAuthorizationSchema.parse(request.body);
    const operator = operatorOf(request);
    const record = await prisma.case.findUnique({
      where: { id: request.params.id },
      include: { scopeEntries: true },
    });
    if (record === null) throw notFound(`Case ${request.params.id} does not exist.`);

    const validFrom = body.validFrom ?? new Date();
    if (body.validUntil <= validFrom) {
      throw badRequest("validUntil must be after validFrom.");
    }

    // The boundary is the case's scope as it stands now. Later scope changes
    // do not widen an authorization already issued; issue a new one.
    const created = await prisma.authorization.create({
      data: {
        reference: record.authorizationRef,
        issuedBy: body.issuedBy,
        boundary: {
          scope: record.scopeEntries.map(toScopeEntry).map((e) => ({ kind: e.kind, value: e.value })),
          entityKinds: body.entityKinds ?? [],
        },
        sourceClasses: body.sourceClasses,
        actionClasses: body.actionClasses,
        validFrom,
        validUntil: body.validUntil,
        createdBy: operator,
      },
    });
    const previous = record.authorizationId;
    await prisma.case.update({ where: { id: record.id }, data: { authorizationId: created.id } });

    await recordAuditEvent({
      caseId: record.id,
      action: "authorization.created",
      actor: operator,
      detail: {
        authorizationId: created.id,
        previousAuthorizationId: previous,
        issuedBy: body.issuedBy,
        sourceClasses: body.sourceClasses,
        actionClasses: body.actionClasses,
        entityKinds: body.entityKinds ?? [],
        validFrom: validFrom.toISOString(),
        validUntil: body.validUntil.toISOString(),
        scopeEntryCount: record.scopeEntries.length,
      },
    });

    return reply.status(201).send(serializeAuthorization(created));
  });

  app.post<{ Params: { id: string } }>("/cases/:id/authorization/revoke", async (request) => {
    const body = revokeSchema.parse(request.body);
    const operator = operatorOf(request);
    const record = await prisma.case.findUnique({
      where: { id: request.params.id },
      include: { authorization: true },
    });
    if (record === null) throw notFound(`Case ${request.params.id} does not exist.`);
    if (record.authorization === null) throw badRequest("This case has no authorization to revoke.");
    if (record.authorization.revokedAt !== null) return serializeAuthorization(record.authorization);

    const revoked = await prisma.authorization.update({
      where: { id: record.authorization.id },
      data: { revokedAt: new Date(), revokedBy: operator, revokedReason: body.reason },
    });
    await recordAuditEvent({
      caseId: record.id,
      action: "authorization.revoked",
      actor: operator,
      detail: { authorizationId: revoked.id, reason: body.reason },
    });
    return serializeAuthorization(revoked);
  });

  // ── collectors ─────────────────────────────────────────────────────────

  app.get("/v2/collectors", async () => ({
    count: listRunnable().length,
    collectors: listRunnable().map((c) => ({
      id: c.id,
      name: c.name,
      sourceClass: c.sourceClass,
      entityKind: c.entityKind,
      subjectRequired: c.subjectRequired,
      licensingTerms: c.licensingTerms,
      tosUrl: c.tosUrl ?? null,
      refreshCadenceSeconds: c.refreshCadenceSeconds,
      rateLimitPerMinute: c.rateLimit.perMinute,
      configured: isConfigured(c),
      configuredBy: c.configuredBy ?? null,
    })),
  }));

  app.post("/v2/collect", async (request, reply) => {
    const body = collectSchema.parse(request.body);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(body.caseId, operator);
    const result = await runCollection({ ctx, caseId, operator, collectorId: body.collectorId, subject: body.subject, params: body.params, log: request.log });
    return reply.send(result);
  });

  // ── observations ───────────────────────────────────────────────────────

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/observations", async (request) => {
    const query = observationsQuery.parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");

    let rows;
    if (query.bbox !== undefined) {
      const ids = await observationIdsInBox({ authorizationId: ctx.authorizationId, caseId, bbox: query.bbox, asOf: query.asOf ?? null, limit: query.limit });
      const found = await prisma.observation.findMany({ where: { id: { in: ids } }, include: { identifiers: true } });
      const order = new Map(ids.map((id, i) => [id, i]));
      rows = found.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    } else {
      rows = await prisma.observation.findMany({
        where: { authorizationId: ctx.authorizationId, caseId, ...(query.asOf === undefined ? {} : { observedAt: { lte: query.asOf } }) },
        orderBy: [{ observedAt: "desc" }, { id: "asc" }],
        take: query.limit,
        include: { identifiers: true },
      });
    }
    const total = await prisma.observation.count({ where: { authorizationId: ctx.authorizationId, caseId } });
    const positions = await positionsOf(rows.map((r) => r.id));

    // The read is the audited act. Ids and a count; the payloads stay here.
    await prisma.accessLog.create({
      data: {
        actor: operator,
        authorizationId: ctx.authorizationId,
        action: "read",
        targetType: "Observation",
        targetIds: rows.map((r) => r.id),
        resultCount: rows.length,
      },
    });

    return {
      caseId,
      authorizationId: ctx.authorizationId,
      count: rows.length,
      total,
      window: query.bbox ?? null,
      observations: rows.map((r) => ({
        id: r.id,
        sourceId: r.sourceId,
        authorizationId: r.authorizationId,
        collectedAt: r.collectedAt,
        observedAt: r.observedAt,
        normalizedPayload: r.normalizedPayload,
        ...(query.raw === "true" ? { rawPayload: r.rawPayload } : {}),
        contentHash: r.contentHash,
        position: positions.get(r.id) ?? null,
        confidenceBp: r.confidenceBp,
        indeterminate: r.indeterminate,
        identifiers: r.identifiers.map((i) => ({
          kind: i.kind, value: i.value, normalizedValue: i.normalizedValue, normalizationVersion: i.normalizationVersion,
        })),
      })),
    };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/observations/density", async (request) => {
    const query = z.object({
      caseId: z.string().min(1),
      cell: z.coerce.number().min(0.001).max(10).default(1),
      asOf: z.coerce.date().optional(),
      bbox: bboxParam.optional(),
      limit: z.coerce.number().int().min(1).max(20_000).default(5_000),
    }).parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    const cells = await observationDensity({ authorizationId: ctx.authorizationId, caseId, cellDegrees: query.cell, asOf: query.asOf ?? null, bbox: query.bbox ?? null, limit: query.limit });
    const total = cells.reduce((sum, c) => sum + c.count, 0);
    // A read of counts, not rows: the log carries the shape of the ask and
    // how much it summarised, and no observation ids, since none were returned.
    await prisma.accessLog.create({
      data: { actor: operator, authorizationId: ctx.authorizationId, action: "read", targetType: "ObservationDensity", targetIds: [], queryText: `cell=${query.cell}${query.bbox === undefined ? "" : ` bbox=${query.bbox.join(",")}`}${query.asOf === undefined ? "" : ` asOf=${query.asOf.toISOString()}`}`, resultCount: total },
    });
    return { caseId, cellDegrees: query.cell, count: cells.length, observations: total, cells };
  });

  // ── resolution ─────────────────────────────────────────────────────────

  app.post("/v2/resolve", async (request) => {
    const body = resolveSchema.parse(request.body);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(body.caseId, operator);
    return runResolution({ ctx, caseId, entityKind: body.entityKind, operator });
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/entities", async (request) => {
    const query = entitiesQuery.parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");

    const entityWhere = {
      resolutionRun: { authorizationId: ctx.authorizationId },
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.q === undefined || query.q === "" ? {} : { canonicalLabel: { contains: query.q, mode: "insensitive" as const } }),
      members: { some: { supersededAt: null } },
    };
    const total = await prisma.entity.count({ where: entityWhere });
    const entities = await prisma.entity.findMany({
      where: entityWhere,
      skip: query.offset,
      include: {
        members: {
          where: { supersededAt: null },
          include: { observation: { select: { id: true, sourceId: true, observedAt: true, collectedAt: true, caseId: true } } },
        },
        resolutionRun: { select: { id: true, modelVersion: true, startedAt: true } },
      },
      orderBy: [{ lastResolvedAt: "desc" }, { id: "asc" }],
      take: query.limit,
    });

    // Sources consulted for this authorization, whether or not they said
    // anything: a source that returned nothing is listed, not dropped.
    const consulted = await prisma.observation.groupBy({
      by: ["sourceId"],
      where: { authorizationId: ctx.authorizationId },
      _count: { _all: true },
      _max: { observedAt: true },
    });
    const registered = listRunnable().map((c) => c.id);
    const sourceIds = [...new Set([...registered, ...consulted.map((c) => c.sourceId)])].sort();
    const sources = sourceIds.map((id) => {
      const hit = consulted.find((c) => c.sourceId === id);
      return { sourceId: id, observations: hit?._count._all ?? 0, lastObservedAt: hit?._max.observedAt ?? null };
    });

    await prisma.accessLog.create({
      data: {
        actor: operator,
        authorizationId: ctx.authorizationId,
        action: "read",
        targetType: "Entity",
        targetIds: entities.map((e) => e.id),
        resultCount: entities.length,
      },
    });

    return {
      caseId,
      authorizationId: ctx.authorizationId,
      count: entities.length,
      total,
      offset: query.offset,
      sources,
      entities: entities.map((e) => ({
        id: e.id,
        kind: e.kind,
        canonicalLabel: e.canonicalLabel,
        status: e.status,
        lastResolvedAt: e.lastResolvedAt,
        run: e.resolutionRun,
        sourceIds: [...new Set(e.members.map((m) => m.observation.sourceId))].sort(),
        members: e.members.map((m) => ({
          observationId: m.observationId,
          sourceId: m.observation.sourceId,
          observedAt: m.observation.observedAt,
          collectedAt: m.observation.collectedAt,
          scoreBp: m.scoreBp,
          method: m.method,
          addedBy: m.addedBy,
          addedAt: m.addedAt,
        })),
      })),
    };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/review", async (request) => {
    const query = entitiesQuery.parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");

    // The latest completed run per kind is the queue; older runs' review
    // pairs were either re-scored or pinned since.
    const runs = await prisma.resolutionRun.findMany({
      where: { authorizationId: ctx.authorizationId, status: "COMPLETE" },
      orderBy: { startedAt: "desc" },
    });
    const latestByKind = new Map<string, { runId: string; modelVersion: string; startedAt: Date }>();
    for (const run of runs) {
      const kindRow = await prisma.entity.findFirst({ where: { resolutionRunId: run.id }, select: { kind: true } });
      // A run that produced no entities has no kind and no review queue. It
      // used to get an "UNKNOWN" sentinel, which is not a FusionEntityKind —
      // the cast below then failed and took the whole tab down with it.
      if (kindRow === null) continue;
      const kind = kindRow.kind;
      if (!latestByKind.has(kind)) latestByKind.set(kind, { runId: run.id, modelVersion: run.modelVersion, startedAt: run.startedAt });
    }
    const chosen = [...latestByKind.entries()].filter(([kind]) => query.kind === undefined || kind === query.kind);
    const runIds = chosen.map(([, run]) => run.runId);
    const kindOfRun = new Map(chosen.map(([kind, run]) => [run.runId, kind]));

    const pending = runIds.length === 0 ? [] : await prisma.matchDecision.findMany({
      where: { runId: { in: runIds }, decision: "REVIEW" },
      orderBy: [{ scoreBp: "desc" }, { id: "asc" }],
      take: query.limit,
    });
    const adjudicated = new Set(
      (await prisma.adjudication.findMany({
        where: { pairKey: { in: pending.map((d) => [d.leftObservationId, d.rightObservationId].sort().join("|")) } },
        select: { pairKey: true },
      })).map((a) => a.pairKey),
    );
    const open = pending.filter((d) => !adjudicated.has([d.leftObservationId, d.rightObservationId].sort().join("|")));

    const observationIds = [...new Set(open.flatMap((d) => [d.leftObservationId, d.rightObservationId]))];
    const observations = await prisma.observation.findMany({
      where: { id: { in: observationIds } },
      include: { identifiers: true },
    });
    const byId = new Map(observations.map((o) => [o.id, o]));
    const brief = (id: string) => {
      const o = byId.get(id);
      return o === undefined ? null : {
        id: o.id, sourceId: o.sourceId, observedAt: o.observedAt,
        identifiers: o.identifiers.map((i) => ({ kind: i.kind, value: i.value })),
        payload: o.normalizedPayload,
      };
    };

    // Decisions recorded since the run that produced each queue. The model
    // hasn't seen them; the next run for that kind applies them as pins.
    const kinds = await Promise.all(
      chosen.map(async ([kind, run]) => {
        const [row] = await prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n
          FROM "Adjudication" a
          JOIN "Observation" o ON o."id" = a."leftObservationId"
          WHERE o."authorizationId" = ${ctx.authorizationId}
            AND o."entityKind" = ${kind}::"FusionEntityKind"
            AND a."createdAt" > ${run.startedAt}`;
        return {
          kind,
          runId: run.runId,
          modelVersion: run.modelVersion,
          startedAt: run.startedAt,
          open: open.filter((d) => d.runId === run.runId).length,
          adjudicatedSinceRun: row?.n ?? 0,
        };
      }),
    );

    await prisma.accessLog.create({
      data: {
        actor: operator, authorizationId: ctx.authorizationId, action: "read",
        targetType: "MatchDecision", targetIds: open.map((d) => d.id), resultCount: open.length,
      },
    });

    return {
      caseId,
      count: open.length,
      kinds,
      pairs: open.map((d) => ({
        decisionId: d.id,
        runId: d.runId,
        kind: kindOfRun.get(d.runId) ?? "UNKNOWN",
        scoreBp: d.scoreBp,
        blockingKey: d.blockingKey,
        features: d.featureVector,
        left: brief(d.leftObservationId),
        right: brief(d.rightObservationId),
      })),
    };
  });

  app.post("/v2/adjudicate", async (request, reply) => {
    const body = adjudicateSchema.parse(request.body);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(body.caseId, operator);
    ctx.assertAction("RESOLVE");
    if (body.leftObservationId === body.rightObservationId) {
      throw badRequest("An adjudication is about two different observations.");
    }

    const both = await prisma.observation.findMany({
      where: { id: { in: [body.leftObservationId, body.rightObservationId] }, authorizationId: ctx.authorizationId },
      select: { id: true },
    });
    if (both.length !== 2) {
      throw notFound("Both observations must exist under this case's authorization.");
    }

    const [left, right] = [body.leftObservationId, body.rightObservationId].sort() as [string, string];
    const row = await prisma.adjudication.create({
      data: {
        pairKey: `${left}|${right}`,
        leftObservationId: left,
        rightObservationId: right,
        decision: body.decision,
        adjudicatedBy: operator,
        note: body.note,
      },
    });
    await recordAuditEvent({
      caseId,
      action: "v2.adjudicated",
      actor: operator,
      detail: { adjudicationId: row.id, left, right, decision: body.decision, note: body.note },
    });
    return reply.status(201).send(row);
  });

  // ── reasoning ──────────────────────────────────────────────────────────

  app.post("/v2/ask", async (request) => {
    const body = z.object({ caseId: z.string().min(1), question: z.string().trim().min(3).max(1_000) }).parse(request.body);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(body.caseId, operator);
    // The same 403 every graph read gives; the executor checks again inside.
    ctx.assertAction("READ_GRAPH");
    const asked = await ask({ ctx, operator, question: body.question });
    return { caseId, authorizationId: ctx.authorizationId, ...asked };
  });

  /**
   * POST /v2/overview — the case in three lines.
   *
   * Not routed through the planner on purpose. The planner expresses six
   * operations and "summarise this case" is none of them, so it would refuse.
   * Instead the aggregates are read from the graph here — counts by kind and
   * status, the observation span, which sources contributed — and the model is
   * given those facts and asked only to write them out. It never sees the
   * graph and cannot add to it, so a sentence it produces is traceable to a
   * number above it.
   *
   * Scope-gated and logged like every other read.
   */
  app.post("/v2/overview", async (request, reply) => {
    const body = z.object({ caseId: z.string().min(1) }).parse(request.body);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(body.caseId, operator);
    ctx.assertAction("READ_GRAPH");

    let client;
    try {
      client = modelClientFromEnv(process.env);
    } catch (error) {
      return reply.send({ available: false, bullets: [], reason: error instanceof Error ? error.message : String(error) });
    }
    if (client === null) {
      return reply.send({ available: false, bullets: [], reason: "No model configured. Set REASON_PROVIDER." });
    }

    const live = { resolutionRun: { authorizationId: ctx.authorizationId }, members: { some: { supersededAt: null } } };
    const [byKind, byStatus, observations, consulted, span] = await Promise.all([
      prisma.entity.groupBy({ by: ["kind"], where: live, _count: { _all: true } }),
      prisma.entity.groupBy({ by: ["status"], where: live, _count: { _all: true } }),
      prisma.observation.count({ where: { authorizationId: ctx.authorizationId } }),
      prisma.observation.groupBy({ by: ["sourceId"], where: { authorizationId: ctx.authorizationId }, _count: { _all: true } }),
      prisma.observation.aggregate({ where: { authorizationId: ctx.authorizationId }, _min: { observedAt: true }, _max: { observedAt: true } }),
    ]);

    const registered = listRunnable().map((c) => c.id);
    const silent = registered.filter((id) => !consulted.some((c) => c.sourceId === id));
    const facts = [
      `Observations: ${observations}`,
      `Entities by kind: ${byKind.map((k) => `${k.kind} ${k._count._all}`).join(", ") || "none"}`,
      `Entities by status: ${byStatus.map((s) => `${s.status} ${s._count._all}`).join(", ") || "none"}`,
      `Sources that contributed: ${consulted.map((c) => `${c.sourceId} ${c._count._all}`).join(", ") || "none"}`,
      `Sources consulted that returned nothing: ${silent.join(", ") || "none"}`,
      `Observed between: ${span._min.observedAt?.toISOString() ?? "n/a"} and ${span._max.observedAt?.toISOString() ?? "n/a"}`,
    ].join("\n");

    try {
      const answer = await client.complete({
        role: "synthesis",
        maxTokens: 400,
        system:
          "You describe the state of an investigation case to its operator. Use only the figures given. " +
          "Do not name a person, place or organisation that does not appear in them, and draw no conclusion " +
          'about what the case means. Reply as JSON: {"bullets": ["…"]} with at most three entries, each one ' +
          "short sentence. Mention sources that returned nothing, because absence is a finding.",
        user: facts,
      });
      const parsed = parseJsonReply(answer.text) as { bullets?: unknown };
      const bullets = Array.isArray(parsed.bullets)
        ? parsed.bullets.filter((b): b is string => typeof b === "string" && b.trim() !== "").slice(0, 3)
        : [];
      if (bullets.length === 0) {
        return reply.send({ available: false, bullets: [], reason: "The model returned nothing usable." });
      }
      await logRead(operator, ctx.authorizationId, "case", [caseId], "overview");
      return reply.send({ available: true, caseId, bullets, model: answer.model });
    } catch (error) {
      return reply.send({ available: false, bullets: [], reason: error instanceof Error ? error.message : String(error) });
    }
  });

  const logRead = async (operator: string, authorizationId: string, targetType: string, targetIds: string[], queryText: string) =>
    prisma.accessLog.create({ data: { actor: operator, authorizationId, action: "read", targetType, targetIds, queryText, resultCount: targetIds.length } });

  // ── recognition (gallery-restricted) ───────────────────────────────────

  app.get("/v2/galleries", async (request) => {
    const operator = operatorOf(request);
    const rows = await prisma.gallery.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { enrollments: true, comparisons: true } } } });
    const now = new Date();
    await recordAuditEvent({ action: "v2.gallery.listed", actor: operator, detail: { count: rows.length } });
    return {
      enabled: recognitionEnabled(),
      count: rows.length,
      galleries: rows.map((g) => ({
        id: g.id, name: g.name, purpose: g.purpose, custodianOrg: g.custodianOrg, lawfulBasis: g.lawfulBasis, lawfulBasisDocumentRef: g.lawfulBasisDocumentRef,
        reviewDueAt: g.reviewDueAt, reviewOverdue: g.reviewDueAt <= now, enrollments: g._count.enrollments, comparisons: g._count.comparisons, createdAt: g.createdAt, createdBy: g.createdBy,
      })),
    };
  });

  app.get<{ Params: { galleryId: string }; Querystring: Record<string, string | undefined> }>("/v2/galleries/:galleryId", async (request) => {
    const query = z.object({ caseId: z.string().min(1).optional() }).parse(request.query);
    const operator = operatorOf(request);
    const gallery = await prisma.gallery.findUnique({ where: { id: request.params.galleryId } });
    if (gallery === null) throw notFound(`Gallery ${request.params.galleryId} does not exist.`);
    const now = new Date();
    const enrollments = await prisma.galleryEnrollment.findMany({ where: { galleryId: gallery.id }, orderBy: { enrolledAt: "asc" } });
    const comparisons = await prisma.biometricComparison.findMany({ where: { galleryId: gallery.id }, orderBy: { requestedAt: "desc" }, take: 50 });
    // Entity labels are a graph read, so they need a case's authorization;
    // without one the enrollments carry ids only.
    let labels = new Map<string, { label: string; kind: string }>();
    if (query.caseId !== undefined) {
      const { ctx } = await scopeContextForCase(query.caseId, operator);
      ctx.assertAction("READ_GRAPH");
      labels = await visibleEntities(ctx, now, [...new Set(enrollments.map((e) => e.entityId))]);
      await logRead(operator, ctx.authorizationId, "GalleryEnrollment", enrollments.map((e) => e.id), `gallery ${gallery.id}`);
    }
    await recordAuditEvent({ action: "v2.gallery.read", actor: operator, detail: { galleryId: gallery.id, enrollments: enrollments.length, comparisons: comparisons.length } });
    const byEnrollment = new Map(enrollments.map((e) => [e.id, e]));
    return {
      enabled: recognitionEnabled(),
      gallery: { ...gallery, reviewOverdue: gallery.reviewDueAt <= now },
      enrollments: enrollments.map((e) => ({
        id: e.id, entityId: e.entityId, label: labels.get(e.entityId)?.label ?? null, kind: labels.get(e.entityId)?.kind ?? null, modality: e.modality,
        enrolledAt: e.enrolledAt, enrolledBy: e.enrolledBy, lawfulBasisDocumentRef: e.lawfulBasisDocumentRef, expiresAt: e.expiresAt, revokedAt: e.revokedAt,
        active: e.revokedAt === null && e.expiresAt > now,
      })),
      comparisons: comparisons.map((c) => ({
        id: c.id, requestedAt: c.requestedAt, requestedBy: c.requestedBy, modality: c.modality, decision: c.decision, probeHash: c.probeHash, thresholdBp: c.thresholdBp,
        topMatches: (c.topMatches as Array<{ enrollmentId: string; distanceBp: number }>).map((m) => {
          const e = byEnrollment.get(m.enrollmentId);
          return { ...m, entityId: e?.entityId ?? null, label: e === undefined ? null : (labels.get(e.entityId)?.label ?? null) };
        }),
      })),
    };
  });

  app.post("/v2/galleries", async (request, reply) => {
    const body = gallerySchema.parse(request.body);
    const gallery = await createGallery(body, operatorOf(request));
    return reply.status(201).send(gallery);
  });

  app.post<{ Params: { galleryId: string } }>("/v2/galleries/:galleryId/enroll", async (request, reply) => {
    const body = enrollSchema.parse(request.body);
    const operator = operatorOf(request);
    const { ctx } = await scopeContextForCase(body.caseId, operator);
    const result = await enroll({ ctx, operator, galleryId: request.params.galleryId, body });
    return reply.status(201).send(result);
  });

  app.post<{ Params: { galleryId: string; enrollmentId: string } }>("/v2/galleries/:galleryId/enrollments/:enrollmentId/revoke", async (request) => {
    const body = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(request.body);
    return revokeEnrollment({ galleryId: request.params.galleryId, enrollmentId: request.params.enrollmentId, operator: operatorOf(request), reason: body.reason });
  });

  // One comparison route, 1:N against a named gallery. The schema requires
  // the gallery; there is no probe-only route and none will be added.
  app.post("/v2/compare", async (request) => {
    const body = compareSchema.parse(request.body);
    const operator = operatorOf(request);
    const { ctx } = await scopeContextForCase(body.caseId, operator);
    return compare({ ctx, operator, body });
  });

  // ── the agent: observe, propose, approve ───────────────────────────────

  app.post("/v2/agent/proposals", async (request, reply) => {
    const body = proposalSchema.parse(request.body);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(body.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    return reply.status(201).send(await propose({ ctx, operator, ...body, caseId }));
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/agent/proposals", async (request) => {
    const query = z.object({ caseId: z.string().min(1), status: z.enum(["PROPOSED", "APPROVED", "EXECUTED", "REJECTED", "REFUSED"]).optional() }).parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    const rows = await prisma.agentProposal.findMany({
      where: { caseId, authorizationId: ctx.authorizationId, ...(query.status === undefined ? {} : { status: query.status }) },
      orderBy: { createdAt: "desc" }, take: 200, include: { approvals: { orderBy: { approvedAt: "desc" } } },
    });
    await logRead(operator, ctx.authorizationId, "AgentProposal", rows.map((r) => r.id), "proposals");
    return { caseId, count: rows.length, maxAutonomousTier: process.env["AGENT_MAX_AUTONOMOUS_TIER"] ?? "observe", proposals: rows };
  });

  app.post<{ Params: { proposalId: string } }>("/v2/agent/proposals/:proposalId/approve", async (request) => {
    const body = z.object({ caseId: z.string().min(1), ttlMinutes: z.number().int().min(1).max(24 * 60).default(60), note: z.string().trim().min(1).max(2000) }).parse(request.body);
    const operator = operatorOf(request);
    const { ctx } = await scopeContextForCase(body.caseId, operator);
    return approveProposal({ ctx, proposalId: request.params.proposalId, approver: operator, ttlMinutes: body.ttlMinutes, note: body.note });
  });

  app.post<{ Params: { proposalId: string } }>("/v2/agent/proposals/:proposalId/reject", async (request) => {
    const body = z.object({ caseId: z.string().min(1), reason: z.string().trim().min(1).max(2000) }).parse(request.body);
    const operator = operatorOf(request);
    const { ctx } = await scopeContextForCase(body.caseId, operator);
    return rejectProposal({ ctx, proposalId: request.params.proposalId, operator, reason: body.reason });
  });

  app.post<{ Params: { proposalId: string } }>("/v2/agent/proposals/:proposalId/execute", async (request) => {
    const body = z.object({ caseId: z.string().min(1) }).parse(request.body);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(body.caseId, operator);
    return executeProposal({ ctx, caseId, proposalId: request.params.proposalId, operator, log: request.log });
  });

  app.post("/v2/agent/monitors", async (request, reply) => {
    const body = monitorSchema.parse(request.body);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(body.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    return reply.status(201).send(await createMonitor({ ctx, caseId, operator, kind: body.kind, name: body.name, params: body.params }));
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/agent/monitors", async (request) => {
    const query = z.object({ caseId: z.string().min(1) }).parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    const rows = await prisma.graphMonitor.findMany({ where: { caseId, authorizationId: ctx.authorizationId }, orderBy: { createdAt: "desc" }, include: { _count: { select: { alerts: true } } } });
    return { caseId, count: rows.length, monitors: rows.map((m) => ({ ...m, alerts: m._count.alerts, _count: undefined })) };
  });

  app.post<{ Params: { monitorId: string } }>("/v2/agent/monitors/:monitorId/disable", async (request) => {
    const body = z.object({ caseId: z.string().min(1), reason: z.string().trim().min(1).max(500) }).parse(request.body);
    const operator = operatorOf(request);
    const { ctx } = await scopeContextForCase(body.caseId, operator);
    return disableMonitor({ ctx, monitorId: request.params.monitorId, operator, reason: body.reason });
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/agent/alerts", async (request) => {
    const query = z.object({ caseId: z.string().min(1), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    const rows = await prisma.graphAlert.findMany({ where: { caseId, authorizationId: ctx.authorizationId }, orderBy: { at: "desc" }, take: query.limit, include: { monitor: { select: { name: true, kind: true } } } });
    await logRead(operator, ctx.authorizationId, "GraphAlert", rows.map((r) => r.id), "alerts");
    return { caseId, count: rows.length, alerts: rows };
  });

  app.post<{ Params: { alertId: string } }>("/v2/agent/alerts/:alertId/acknowledge", async (request) => {
    const body = z.object({ caseId: z.string().min(1) }).parse(request.body);
    const operator = operatorOf(request);
    const { ctx } = await scopeContextForCase(body.caseId, operator);
    const alert = await prisma.graphAlert.findFirst({ where: { id: request.params.alertId, authorizationId: ctx.authorizationId } });
    if (alert === null) throw notFound(`Alert ${request.params.alertId} is not under this authorization.`);
    return prisma.graphAlert.update({ where: { id: alert.id }, data: { acknowledgedAt: new Date(), acknowledgedBy: operator } });
  });

  // A sweep on demand: what the scheduler does on its timer.
  app.post("/v2/agent/tick", async (request) => {
    const operator = operatorOf(request);
    return agentTick(operator, Date.now());
  });

  // ── the temporal graph ─────────────────────────────────────────────────

  app.post("/v2/links/derive", async (request) => {
    const body = deriveSchema.parse(request.body);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(body.caseId, operator);
    return deriveLinks({
      ctx, caseId, operator,
      options: { ...(body.radiusM === undefined ? {} : { radiusM: body.radiusM }), ...(body.windowMinutes === undefined ? {} : { windowMinutes: body.windowMinutes }) },
    });
  });


  // ── imagery ────────────────────────────────────────────────────────────

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/imagery/tiles", async (request) => {
    const query = z.object({
      caseId: z.string().min(1),
      /** west,south,east,north; only tiles overlapping it are listed. */
      bbox: z.string().regex(/^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }).parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    const box = query.bbox === undefined ? null : (query.bbox.split(",").map(Number) as [number, number, number, number]);
    const rows = await prisma.imageryTile.findMany({ where: { authorizationId: ctx.authorizationId }, orderBy: [{ sensedAt: "desc" }, { id: "asc" }], take: query.limit });
    const tiles = rows.filter((t) => {
      if (box === null) return true;
      const [w, s, e, n] = t.bbox as [number, number, number, number];
      return e >= box[0] && w <= box[2] && n >= box[1] && s <= box[3];
    });
    await logRead(operator, ctx.authorizationId, "ImageryTile", tiles.map((t) => t.id), `tiles${box === null ? "" : ` bbox=${query.bbox}`}`);
    return {
      caseId,
      count: tiles.length,
      tiles: tiles.map((t) => ({
        id: t.id, sourceId: t.sourceId, sceneId: t.sceneId, sensedAt: t.sensedAt, cloudCoverPct: t.cloudCoverPct, bbox: t.bbox,
        hasPreview: t.previewKey !== null, bytes: t.bytes, widthPx: t.widthPx, heightPx: t.heightPx, resolutionM: t.resolutionM, format: t.format, cloudOptimized: t.cloudOptimized,
      })),
    };
  });

  app.get<{ Params: { tileId: string }; Querystring: Record<string, string | undefined> }>("/v2/imagery/preview/:tileId", async (request, reply) => {
    const query = z.object({ caseId: z.string().min(1) }).parse(request.query);
    const operator = operatorOf(request);
    const { ctx } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    // A tile under another authorization is not "forbidden", it is not there.
    const tile = await prisma.imageryTile.findFirst({ where: { id: request.params.tileId, authorizationId: ctx.authorizationId } });
    if (tile === null || tile.previewKey === null) throw notFound(`No preview for tile ${request.params.tileId} under this authorization.`);
    const store = objectStore();
    if (store === null) throw new HttpError(503, "storage-unavailable", "Object storage is not configured, so stored imagery cannot be served.");
    const object = await store.get(TILES_BUCKET(), tile.previewKey);
    if (object === null) throw notFound(`The preview for tile ${tile.id} is indexed but missing from storage.`);
    await logRead(operator, ctx.authorizationId, "ImageryTile", [tile.id], `preview ${tile.id}`);
    return reply.header("content-type", object.contentType ?? "image/png").header("cache-control", "private, max-age=3600").send(Buffer.from(object.body));
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/graph/edges", async (request) => {
    const query = asOfQuery.extend({ entityId: z.string().min(1).optional() }).parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    const asOf = query.asOf ?? new Date();
    const knownAs = query.knownAs ?? new Date();
    const nodes = await visibleEntities(ctx, knownAs, query.entityId === undefined ? undefined : [query.entityId]);
    const edges = (await edgesAsOf(asOf, { authorizationId: ctx.authorizationId, knownAs, ...(query.entityId === undefined ? {} : { entityIds: [query.entityId] }) }))
      .filter(() => (query.entityId === undefined ? true : nodes.has(query.entityId)));
    const endpoints = await visibleEntities(ctx, knownAs, [...new Set(edges.flatMap((e) => [e.fromEntityId, e.toEntityId]))]);
    const shown = edges.filter((e) => endpoints.has(e.fromEntityId) && endpoints.has(e.toEntityId));
    await logRead(operator, ctx.authorizationId, "EntityEdge", shown.map((e) => e.id), `edges asOf=${asOf.toISOString()} knownAs=${knownAs.toISOString()}`);
    return { caseId, asOf, knownAs, count: shown.length, nodes: [...endpoints.values()], edges: shown };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/graph/neighbors", async (request) => {
    const query = asOfQuery.extend({ entityId: z.string().min(1), hops: z.coerce.number().int().min(1).max(3).default(1) }).parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    const result = await neighbors({ ctx, entityId: query.entityId, asOf: query.asOf ?? new Date(), knownAs: query.knownAs ?? new Date(), hops: query.hops });
    await logRead(operator, ctx.authorizationId, "Entity", result.nodes.map((n) => n.id), `neighbors ${query.entityId} hops=${query.hops} asOf=${result.asOf.toISOString()}`);
    return { caseId, ...result };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/graph/path", async (request) => {
    const query = asOfQuery.extend({ from: z.string().min(1), to: z.string().min(1), maxHops: z.coerce.number().int().min(1).max(6).default(4) }).parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    const result = await pathBetween({ ctx, from: query.from, to: query.to, asOf: query.asOf ?? new Date(), knownAs: query.knownAs ?? new Date(), maxHops: query.maxHops });
    await logRead(operator, ctx.authorizationId, "Entity", result.nodes.map((n) => n.id), `path ${query.from}→${query.to} maxHops=${query.maxHops} asOf=${result.asOf.toISOString()}`);
    return { caseId, ...result };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/graph/timeline", async (request) => {
    const query = asOfQuery.extend({ entityId: z.string().min(1) }).parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    const result = await timelineForEntity({ ctx, entityId: query.entityId, asOf: query.asOf ?? new Date(), knownAs: query.knownAs ?? new Date() });
    await logRead(operator, ctx.authorizationId, "Entity", [query.entityId], `timeline ${query.entityId} asOf=${result.asOf.toISOString()}`);
    return { caseId, ...result };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/graph/colocation", async (request) => {
    const query = z.object({ caseId: z.string().min(1), entityId: z.string().min(1), from: z.coerce.date(), to: z.coerce.date() }).parse(request.query);
    if (query.to <= query.from) throw badRequest("to must be after from.");
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    const result = await coLocationWindow({ ctx, entityId: query.entityId, from: query.from, to: query.to });
    await logRead(operator, ctx.authorizationId, "EntityEdge", result.edges.map((e) => e.id), `colocation ${query.entityId} ${query.from.toISOString()}..${query.to.toISOString()}`);
    return { caseId, from: query.from, to: query.to, ...result };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/graph/colocation/clusters", async (request) => {
    const query = asOfQuery.parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    const result = await coLocationClusters({ ctx, asOf: query.asOf ?? new Date(), knownAs: query.knownAs ?? new Date() });
    await logRead(operator, ctx.authorizationId, "Entity", [...new Set(result.clusters.flatMap((c) => c.entities.map((e) => e.id)))], `colocation clusters asOf=${result.asOf.toISOString()}`);
    return { caseId, ...result, count: result.clusters.length };
  });

  app.post("/v2/graph/consistency", async (request) => {
    const body = z.object({ caseId: z.string().min(1) }).parse(request.body);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(body.caseId, operator);
    ctx.assertAction("READ_GRAPH");
    const report = await checkGraphConsistency(200, ctx.authorizationId);
    await recordAuditEvent({
      caseId, action: "v2.graph.checked", actor: operator,
      detail: { authorizationId: ctx.authorizationId, clean: report.clean, danglingEvidence: report.danglingEvidence.length, resolvedWithoutMembers: report.resolvedWithoutMembers.length, selfEdges: report.selfEdges.length, supersededBeforeCreated: report.supersededBeforeCreated.length },
    });
    return { caseId, ...report };
  });
}

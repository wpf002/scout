import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { subjectSchema } from "@scout/sources";
import {
  ScopeError,
  actionClassSchema,
  sourceClassSchema,
} from "@scout/scope";
import {
  assertMayCollect,
  assertProvenance,
  contentHash,
  fusionEntityKindSchema,
  type ObservationInput,
} from "@scout/fusion";
import {
  insertObservations,
  positionsOf,
  prisma,
  recordAuditEvent,
  toScopeEntry,
  type ObservationRow,
} from "@scout/db";
import { badRequest, notFound } from "../errors.js";
import { operatorOf } from "../auth.js";
import { logEvent } from "../observability.js";
import { upstreamMessage } from "../adapters/base.js";
import { scopeContextForCase } from "../v2/scope.js";
import {
  NORMALIZATION_VERSION,
  ensureCollectionSource,
  getRunnable,
  isConfigured,
  listRunnable,
  naiveNormalize,
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
});

const observationsQuery = z.object({
  caseId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  raw: z.enum(["true", "false"]).default("false"),
});

/**
 * Deterministic id: the same fact from the same source under the same
 * authorization is the same row. A second authorization collecting the same
 * fact gets its own row, because provenance names one authorization per row.
 */
function observationId(sourceId: string, authorizationId: string, hash: string): string {
  return `obs_${createHash("sha256").update(`${sourceId}|${authorizationId}|${hash}`).digest("hex").slice(0, 24)}`;
}

function toRow(input: ObservationInput): ObservationRow {
  const hash = contentHash(input.normalizedPayload);
  return {
    id: observationId(input.sourceId, input.authorizationId, hash),
    sourceId: input.sourceId,
    authorizationId: input.authorizationId,
    caseId: input.caseId ?? null,
    collectedAt: input.collectedAt,
    observedAt: input.observedAt,
    rawPayload: input.rawPayload,
    normalizedPayload: input.normalizedPayload,
    contentHash: hash,
    position: input.position,
    confidenceBp: input.confidenceBp,
    indeterminate: input.indeterminate,
  };
}

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

    const collector = getRunnable(body.collectorId);
    if (collector === undefined) throw notFound(`Collector "${body.collectorId}" is not registered.`);

    // Order matters and mirrors v1's adapter gate: every refusal is decided
    // before anything is fetched, and the most specific reason wins.
    assertMayCollect(ctx, collector);
    if (!ctx.permitsEntityKind(collector.entityKind)) {
      throw new ScopeError(
        "out-of-scope",
        `Authorization ${ctx.reference} does not cover ${collector.entityKind} entities.`,
      );
    }
    if (collector.subjectRequired) {
      if (body.subject === undefined) {
        throw badRequest(`${collector.name} collects about a subject; none was given.`);
      }
      ctx.assertCovers(body.subject);
    }

    await ensureCollectionSource(collector);

    if (!isConfigured(collector)) {
      await recordAuditEvent({
        caseId, action: "v2.collection.ran", actor: operator,
        detail: { collectorId: collector.id, authorizationId: ctx.authorizationId, outcome: "inert", reason: "not-configured" },
      });
      return reply.send({
        status: "inert",
        collectorId: collector.id,
        reason: "not-configured",
        message: `${collector.name} needs ${collector.configuredBy} set. Nothing was requested.`,
        written: 0,
        skipped: 0,
        observationIds: [],
      });
    }

    const collectedAt = new Date();
    const meta = { collectedAt, authorizationId: ctx.authorizationId, caseId };

    let raw: unknown;
    try {
      raw = await collector.fetch({ subject: body.subject });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordAuditEvent({
        caseId, action: "v2.collection.ran", actor: operator,
        detail: { collectorId: collector.id, authorizationId: ctx.authorizationId, outcome: "error", errorMessage: upstreamMessage(collector.name, message) },
      });
      return reply.send({
        status: "error",
        collectorId: collector.id,
        reason: "upstream-error",
        message: upstreamMessage(collector.name, message),
        written: 0,
        skipped: 0,
        observationIds: [],
      });
    }

    const inputs = collector.normalize(raw, meta).map((input) => assertProvenance(input));

    // The window is re-checked here rather than trusted from the top of the
    // handler: a slow upstream can outlive a short authorization.
    ctx.assertLive();

    const rows = inputs.map(toRow);
    const written = await insertObservations(rows);
    const writtenSet = new Set(written);

    const identifierRows = inputs.flatMap((input, index) => {
      const id = rows[index]?.id;
      if (id === undefined || !writtenSet.has(id)) return [];
      return input.identifiers.map((identifier) => ({
        observationId: id,
        kind: identifier.kind,
        value: identifier.value,
        normalizedValue: naiveNormalize(identifier.kind, identifier.value),
        normalizationVersion: NORMALIZATION_VERSION,
      }));
    });
    if (identifierRows.length > 0) {
      await prisma.identifier.createMany({ data: identifierRows });
    }

    const skipped = rows.length - written.length;
    await recordAuditEvent({
      caseId, action: "v2.collection.ran", actor: operator,
      detail: {
        collectorId: collector.id,
        authorizationId: ctx.authorizationId,
        outcome: "ok",
        subjectKind: body.subject?.kind ?? null,
        requested: rows.length,
        written: written.length,
        skipped,
      },
    });
    logEvent(request.log, "collection.ran", {
      collectorId: collector.id, requested: rows.length, written: written.length, skipped,
    });

    return reply.send({
      status: "ok",
      collectorId: collector.id,
      sourceClass: collector.sourceClass,
      entityKind: collector.entityKind,
      requested: rows.length,
      written: written.length,
      skipped,
      observationIds: written,
      sourcesConsulted: [{ sourceId: collector.id, status: "ok", records: rows.length }],
    });
  });

  // ── observations ───────────────────────────────────────────────────────

  app.get<{ Querystring: Record<string, string | undefined> }>("/v2/observations", async (request) => {
    const query = observationsQuery.parse(request.query);
    const operator = operatorOf(request);
    const { ctx, caseId } = await scopeContextForCase(query.caseId, operator);
    ctx.assertAction("READ_GRAPH");

    const rows = await prisma.observation.findMany({
      where: { authorizationId: ctx.authorizationId, caseId },
      orderBy: [{ observedAt: "desc" }, { id: "asc" }],
      take: query.limit,
      include: { identifiers: true },
    });
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
}

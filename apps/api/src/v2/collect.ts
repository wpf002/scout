import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Subject } from "@scout/sources";
import { ScopeError, type ScopeContext } from "@scout/scope";
import { assertMayCollect, assertProvenance, contentHash, type ObservationInput } from "@scout/fusion";
import { insertObservations, prisma, recordAuditEvent, type ObservationRow } from "@scout/db";

import { badRequest, notFound } from "../errors.js";
import { logEvent } from "../observability.js";
import { upstreamMessage } from "../adapters/base.js";
import { NORMALIZATION_VERSION, ensureCollectionSource, getRunnable, isConfigured, naiveNormalize } from "./collectors/index.js";

/**
 * One collection run, as the route and the agent both perform it. Every
 * refusal is decided before anything is fetched, and the most specific
 * reason wins; the outcome is audited whether the upstream answered,
 * refused, or was never asked.
 */

/**
 * Deterministic id: the same fact from the same source under the same
 * authorization is the same row. A second authorization collecting the same
 * fact gets its own row, because provenance names one authorization per row.
 */
export function observationId(sourceId: string, authorizationId: string, hash: string): string {
  return `obs_${createHash("sha256").update(`${sourceId}|${authorizationId}|${hash}`).digest("hex").slice(0, 24)}`;
}

export function toRow(input: ObservationInput): ObservationRow {
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
    entityKind: input.entityKind ?? null,
  };
}


export interface CollectionOutcome {
  status: "ok" | "inert" | "error";
  collectorId: string;
  sourceClass?: string;
  entityKind?: string;
  reason?: string;
  message?: string;
  requested?: number;
  written: number;
  skipped: number;
  observationIds: string[];
  sourcesConsulted?: Array<{ sourceId: string; status: string; records: number }>;
}

export async function runCollection(input: {
  ctx: ScopeContext;
  caseId: string;
  operator: string;
  collectorId: string;
  subject?: Subject | undefined;
  params?: Record<string, unknown> | undefined;
  log?: FastifyBaseLogger;
}): Promise<CollectionOutcome> {
  const { ctx, caseId, operator } = input;
  const collector = getRunnable(input.collectorId);
  if (collector === undefined) throw notFound(`Collector "${input.collectorId}" is not registered.`);

  // Order matters and mirrors v1's adapter gate: every refusal is decided
  // before anything is fetched, and the most specific reason wins.
  assertMayCollect(ctx, collector);
  if (!ctx.permitsEntityKind(collector.entityKind)) {
    throw new ScopeError("out-of-scope", `Authorization ${ctx.reference} does not cover ${collector.entityKind} entities.`);
  }
  if (collector.subjectRequired) {
    if (input.subject === undefined) throw badRequest(`${collector.name} collects about a subject; none was given.`);
    ctx.assertCovers(input.subject);
  }

  // The collector's own parameters, checked before anything is fetched or
  // audited: a bad bounding box is the caller's error, not an upstream's.
  const params = collector.paramsSchema === undefined ? input.params : (collector.paramsSchema.parse(input.params ?? {}) as Record<string, unknown>);

  await ensureCollectionSource(collector);

  if (!isConfigured(collector)) {
    await recordAuditEvent({
      caseId, action: "v2.collection.ran", actor: operator,
      detail: { collectorId: collector.id, authorizationId: ctx.authorizationId, outcome: "inert", reason: "not-configured" },
    });
    return { status: "inert", collectorId: collector.id, reason: "not-configured", message: `${collector.name} needs ${collector.configuredBy} set. Nothing was requested.`, written: 0, skipped: 0, observationIds: [] };
  }

  const collectedAt = new Date();
  const meta = { collectedAt, authorizationId: ctx.authorizationId, caseId };

  let raw: unknown;
  try {
    raw = await collector.fetch({ subject: input.subject, params, authorizationId: ctx.authorizationId, caseId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordAuditEvent({
      caseId, action: "v2.collection.ran", actor: operator,
      detail: { collectorId: collector.id, authorizationId: ctx.authorizationId, outcome: "error", errorMessage: upstreamMessage(collector.name, message) },
    });
    return { status: "error", collectorId: collector.id, reason: "upstream-error", message: upstreamMessage(collector.name, message), written: 0, skipped: 0, observationIds: [] };
  }

  const inputs = collector.normalize(raw, meta).map((row) => assertProvenance(row));

  // The window is re-checked here rather than trusted from the top: a slow
  // upstream can outlive a short authorization.
  ctx.assertLive();

  const rows = inputs.map(toRow);
  const written = await insertObservations(rows);
  const writtenSet = new Set(written);

  const identifierRows = inputs.flatMap((row, index) => {
    const id = rows[index]?.id;
    if (id === undefined || !writtenSet.has(id)) return [];
    return row.identifiers.map((identifier) => ({
      observationId: id,
      kind: identifier.kind,
      value: identifier.value,
      normalizedValue: naiveNormalize(identifier.kind, identifier.value),
      normalizationVersion: NORMALIZATION_VERSION,
    }));
  });
  if (identifierRows.length > 0) await prisma.identifier.createMany({ data: identifierRows });

  const skipped = rows.length - written.length;
  await recordAuditEvent({
    caseId, action: "v2.collection.ran", actor: operator,
    detail: { collectorId: collector.id, authorizationId: ctx.authorizationId, outcome: "ok", subjectKind: input.subject?.kind ?? null, requested: rows.length, written: written.length, skipped },
  });
  if (input.log !== undefined) logEvent(input.log, "collection.ran", { collectorId: collector.id, requested: rows.length, written: written.length, skipped });

  return {
    status: "ok", collectorId: collector.id, sourceClass: collector.sourceClass, entityKind: collector.entityKind,
    requested: rows.length, written: written.length, skipped, observationIds: written,
    sourcesConsulted: [{ sourceId: collector.id, status: "ok", records: rows.length }],
  };
}

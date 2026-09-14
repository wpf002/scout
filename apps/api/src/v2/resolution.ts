import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ScopeContext, ScopeError } from "@scout/scope";
import type { FusionEntityKind } from "@scout/fusion";
import { positionsOf, prisma, recordAuditEvent } from "@scout/db";
import { HttpError, badRequest } from "../errors.js";

/**
 * Talking to the resolution service, and writing down what it said.
 *
 * The service scores and clusters; it holds no state. This module gathers
 * the observations an authorization is allowed to see, sends them with the
 * analyst's pinned decisions, and persists the answer: a ResolutionRun, a
 * MatchDecision for every pair scored, an Entity per cluster, and memberships
 * that supersede the previous run's without deleting them.
 */

/** How long one resolution run may take, service call and persistence each. Default ten minutes. */
export function resolutionTimeoutMs(): number {
  const parsed = Number(process.env["RESOLUTION_TIMEOUT_MS"]);
  return Number.isInteger(parsed) && parsed >= 10_000 ? parsed : 600_000;
}

export function resolutionServiceUrl(): string {
  return (process.env["RESOLUTION_SERVICE_URL"] ?? "http://127.0.0.1:8100").replace(/\/$/, "");
}

const decisionSchema = z.object({
  left: z.string(),
  right: z.string(),
  score_bp: z.number().int().min(0).max(10_000).nullable(),
  decision: z.enum(["MATCH", "NON_MATCH", "REVIEW", "INDETERMINATE"]),
  blocking_key: z.string(),
  features: z.record(z.string(), z.unknown()),
  pinned: z.boolean(),
});

const clusterSchema = z.object({
  members: z.array(z.string()).min(1),
  status: z.enum(["RESOLVED", "PROVISIONAL", "DISPUTED"]),
  pending_review: z.number().int(),
  conflicts: z.array(z.array(z.string())),
  label: z.string(),
});

export const resolveResponseSchema = z.object({
  authorization_id: z.string(),
  entity_kind: z.string(),
  model_version: z.string(),
  normalization_version: z.string(),
  thresholds: z.object({ match_bp: z.number().int(), review_bp: z.number().int() }),
  decisions: z.array(decisionSchema),
  clusters: z.array(clusterSchema),
  counts: z.record(z.string(), z.number()),
});
export type ResolveResponse = z.infer<typeof resolveResponseSchema>;

export interface ServiceObservation {
  id: string;
  identifiers: { kind: string; value: string }[];
  payload: Record<string, unknown>;
  observed_at: string | null;
  position: { lon: number; lat: number } | null;
}

export interface ServiceRequest {
  authorization_id: string;
  entity_kind: FusionEntityKind;
  observations: ServiceObservation[];
  adjudications: { left: string; right: string; decision: "MATCH" | "NON_MATCH" | "INDETERMINATE" }[];
}

export interface StreamHandlers {
  onHeader(header: { model_version: string; normalization_version: string; thresholds: { match_bp: number; review_bp: number } }): Promise<void> | void;
  onDecision(decision: z.infer<typeof decisionSchema>): Promise<void> | void;
  onCluster(cluster: z.infer<typeof clusterSchema>): Promise<void> | void;
}

const streamHeaderSchema = z.object({ type: z.literal("header"), model_version: z.string(), normalization_version: z.string(), thresholds: z.object({ match_bp: z.number().int(), review_bp: z.number().int() }) });
const streamSummarySchema = z.object({ type: z.literal("summary"), counts: z.record(z.string(), z.number()) });

/** The request as NDJSON, produced as it is read so a large run is never one string on this side either. */
function ndjsonBody(request: ServiceRequest): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = (function* () {
    yield JSON.stringify({ type: "header", authorization_id: request.authorization_id, entity_kind: request.entity_kind, adjudications: request.adjudications, thresholds: null }) + "\n";
    for (const o of request.observations) yield JSON.stringify({ type: "observation", ...o }) + "\n";
  })();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      let batch = "";
      for (let i = 0; i < 500; i += 1) {
        const next = lines.next();
        if (next.done) {
          if (batch.length > 0) controller.enqueue(encoder.encode(batch));
          controller.close();
          return;
        }
        batch += next.value;
      }
      controller.enqueue(encoder.encode(batch));
    },
  });
}

/**
 * One run through the service's streaming route. Observations go out as
 * lines; decisions and clusters come back as lines and are handed to the
 * caller one at a time, so neither side holds the run as a single string.
 * Returns the counts the service reported.
 */
export async function streamResolution(request: ServiceRequest, handlers: StreamHandlers): Promise<Record<string, number>> {
  let response: Response;
  try {
    response = await fetch(`${resolutionServiceUrl()}/resolve/stream`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson", accept: "application/x-ndjson" },
      body: ndjsonBody(request),
      // A run over tens of thousands of observations takes minutes; the
      // bound is configurable and generous, not a guess at the small case.
      signal: AbortSignal.timeout(resolutionTimeoutMs()),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch (error) {
    const inner = error instanceof Error ? (error.cause as (Error & { code?: string; cause?: unknown }) | undefined) : undefined;
    const cause = inner instanceof Error ? ` (${inner.code ?? inner.name}: ${inner.message}${inner.cause instanceof Error ? `; ${inner.cause.message}` : ""})` : "";
    throw new HttpError(
      502,
      "resolution-unavailable",
      `The resolution service at ${resolutionServiceUrl()} did not answer: ${error instanceof Error ? error.message : String(error)}${cause}. Start it with: cd services/resolution && uv run uvicorn resolution.main:app --port 8100`,
    );
  }
  if (!response.ok) {
    const text = await response.text();
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { detail?: { message?: string } };
      detail = parsed.detail?.message ?? detail;
    } catch {
      // Not JSON; the raw text is the detail.
    }
    throw new HttpError(response.status === 422 ? 422 : 502, "resolution-failed", `Resolution service responded ${response.status}: ${detail}`);
  }
  if (response.body === null) throw new HttpError(502, "resolution-failed", "The resolution service answered with no body.");

  const decoder = new TextDecoder();
  let buffer = "";
  let counts: Record<string, number> | null = null;
  let sawHeader = false;
  const handle = async (line: string) => {
    const parsed = JSON.parse(line) as { type?: string };
    switch (parsed.type) {
      case "header":
        sawHeader = true;
        await handlers.onHeader(streamHeaderSchema.parse(parsed));
        return;
      case "decision":
        await handlers.onDecision(decisionSchema.parse(parsed));
        return;
      case "cluster":
        await handlers.onCluster(clusterSchema.parse(parsed));
        return;
      case "summary":
        counts = streamSummarySchema.parse(parsed).counts;
        return;
      case "error": {
        // A refusal the service could only discover after the stream began
        // (a batch that blocks too wide, say). The status is already 200;
        // the run is aborted here with the reason.
        const detail = (parsed as { detail?: { message?: string; error?: string } }).detail;
        throw new HttpError(detail?.error === "too-many-pairs" ? 422 : 502, "resolution-failed", detail?.message ?? "The resolution service reported an error mid-run.");
      }
      default:
        throw new HttpError(502, "resolution-failed", `The resolution service sent a line of type ${String(parsed.type)}.`);
    }
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) await handle(line);
      newline = buffer.indexOf("\n");
    }
  }
  const tail = (buffer + decoder.decode()).trim();
  if (tail.length > 0) await handle(tail);
  if (!sawHeader || counts === null) throw new HttpError(502, "resolution-failed", "The resolution service's stream ended before its summary.");
  return counts;
}

export interface RunResolutionInput {
  ctx: ScopeContext;
  caseId: string;
  entityKind: FusionEntityKind;
  operator: string;
}

export interface RunSummary {
  runId: string;
  entityKind: FusionEntityKind;
  modelVersion: string;
  normalizationVersion: string;
  thresholds: { matchBp: number; reviewBp: number };
  counts: Record<string, number>;
  entities: { id: string; status: string; label: string; members: string[] }[];
}

export async function runResolution(input: RunResolutionInput): Promise<RunSummary> {
  const { ctx, caseId, entityKind, operator } = input;
  ctx.assertAction("RESOLVE");
  if (!ctx.permitsEntityKind(entityKind)) {
    throw new ScopeError("out-of-scope", `Authorization ${ctx.reference} does not cover ${entityKind} entities.`);
  }

  const observations = await prisma.observation.findMany({
    where: { authorizationId: ctx.authorizationId, caseId, entityKind },
    include: { identifiers: true },
    orderBy: { id: "asc" },
  });
  if (observations.length === 0) {
    throw badRequest(`No ${entityKind} observations have been collected under this authorization yet.`);
  }
  const ids = observations.map((o) => o.id);
  const idSet = new Set(ids);
  const positions = await positionsOf(ids);

  // Pinned decisions: the newest adjudication per pair, only for pairs whose
  // observations are both in this run. The resolver reads them before it
  // clusters, so a human's call survives every re-run.
  // Joined on the observations of this run rather than passed as an id
  // list: Postgres allows 32 767 bind variables, and a run is bigger.
  const adjudications = await prisma.$queryRaw<Array<{ pairKey: string; leftObservationId: string; rightObservationId: string; decision: "MATCH" | "NON_MATCH" | "INDETERMINATE" | "REVIEW" }>>`
    SELECT a."pairKey", a."leftObservationId", a."rightObservationId", a."decision"::text AS "decision"
    FROM "Adjudication" a
    JOIN "Observation" l ON l."id" = a."leftObservationId"
    JOIN "Observation" r ON r."id" = a."rightObservationId"
    WHERE l."authorizationId" = ${ctx.authorizationId} AND r."authorizationId" = ${ctx.authorizationId}
      AND l."caseId" = ${caseId} AND r."caseId" = ${caseId}
    ORDER BY a."createdAt" DESC`;
  const pins = new Map<string, { left: string; right: string; decision: "MATCH" | "NON_MATCH" | "INDETERMINATE" }>();
  for (const a of adjudications) {
    if (pins.has(a.pairKey) || !idSet.has(a.leftObservationId) || !idSet.has(a.rightObservationId)) continue;
    if (a.decision === "REVIEW") continue;
    pins.set(a.pairKey, { left: a.leftObservationId, right: a.rightObservationId, decision: a.decision });
  }

  // The run row first: decisions are written against it as they stream
  // in, outside any transaction, so a run of a million pairs is never one
  // statement or one string. If the run fails after this point it is marked
  // FAILED with the reason and its decisions stay attributed to it.
  // The row is created when the stream's header arrives, because the
  // schema's band check refuses a run whose thresholds are not yet known:
  // placeholders would be a collapsed band on disk, even for a moment.
  let run: { id: string } | null = null;
  const runId = (): string => {
    if (run === null) throw new HttpError(502, "resolution-failed", "The resolution service sent decisions before its header.");
    return run.id;
  };
  const BATCH = 2_000;
  const header = { model_version: "", normalization_version: "", thresholds: { match_bp: 0, review_bp: 0 } };
  const clusters: Array<z.infer<typeof clusterSchema>> = [];
  const bestMatch = new Map<string, number>();
  let pending: Array<{ runId: string; leftObservationId: string; rightObservationId: string; scoreBp: number | null; decision: "MATCH" | "NON_MATCH" | "REVIEW" | "INDETERMINATE"; featureVector: Record<string, unknown>; modelVersion: string; blockingKey: string }> = [];
  let decisionCount = 0;
  const flush = async () => {
    if (pending.length === 0) return;
    await prisma.matchDecision.createMany({ data: pending as never, skipDuplicates: true });
    pending = [];
  };
  let counts: Record<string, number>;
  try {
    counts = await streamResolution(
      {
        authorization_id: ctx.authorizationId,
        entity_kind: entityKind,
        observations: observations.map((o) => ({
          id: o.id,
          identifiers: o.identifiers.map((i) => ({ kind: i.kind, value: i.value })),
          payload: (o.normalizedPayload ?? {}) as Record<string, unknown>,
          observed_at: o.observedAt.toISOString(),
          position: positions.get(o.id) ?? null,
        })),
        adjudications: [...pins.values()],
      },
      {
        async onHeader(h) {
          Object.assign(header, h);
          run = await prisma.resolutionRun.create({
            data: {
              authorizationId: ctx.authorizationId,
              modelVersion: h.model_version,
              normalizationVersion: h.normalization_version,
              matchThresholdBp: h.thresholds.match_bp,
              reviewThresholdBp: h.thresholds.review_bp,
              triggeredBy: operator,
            },
          });
        },
        async onDecision(d) {
          decisionCount += 1;
          if (d.decision === "MATCH" && d.score_bp !== null) {
            for (const id of [d.left, d.right]) bestMatch.set(id, Math.max(bestMatch.get(id) ?? 0, d.score_bp));
          }
          pending.push({ runId: runId(), leftObservationId: d.left, rightObservationId: d.right, scoreBp: d.score_bp, decision: d.decision, featureVector: { ...d.features, pinned: d.pinned }, modelVersion: header.model_version, blockingKey: d.blocking_key });
          if (pending.length >= BATCH) await flush();
        },
        onCluster(c) {
          clusters.push(c);
        },
      },
    );
    await flush();
    // Re-checked after the round trip: the service can take a while, and an
    // authorization revoked meanwhile must not have its results written.
    ctx.assertLive();
  } catch (caught) {
    // `run` is assigned inside the stream's header handler, which TypeScript's
    // flow analysis cannot see from here; read it through its declared type.
    const failed = run as { id: string } | null;
    if (failed !== null) {
      await prisma.resolutionRun.update({ where: { id: failed.id }, data: { status: "FAILED", finishedAt: new Date(), errorMessage: (caught instanceof Error ? caught.message : String(caught)).slice(0, 2000) } }).catch(() => undefined);
    }
    throw caught;
  }
  const created = run as { id: string } | null;
  if (created === null) throw new HttpError(502, "resolution-failed", "The resolution service's stream carried no header.");
  const runRow: { id: string } = created;
  const result = { model_version: header.model_version, normalization_version: header.normalization_version, thresholds: header.thresholds, clusters, counts, decisions: { length: decisionCount } };
  const now = new Date();

  const summary = await prisma.$transaction(
    async (tx) => {
      // What the previous run left: which entity each observation sits in.
      // An entity keeps its id across runs when its cluster is unchanged or
      // only grew, so a monitor, an enrollment or a citation that names it
      // stays true; a merge or a split is a new entity, and the old one is
      // superseded with its history intact.
      const previousMembers = await tx.$queryRaw<Array<{ entityId: string; observationId: string }>>`
        SELECT "entityId", "observationId" FROM "EntityMember"
        WHERE "observationId" = ANY(${ids}::text[]) AND "supersededAt" IS NULL AND "addedBy" = 'SYSTEM'`;
      const membersOf = new Map<string, Set<string>>();
      const entityOf = new Map<string, string>();
      for (const m of previousMembers) {
        membersOf.set(m.entityId, (membersOf.get(m.entityId) ?? new Set()).add(m.observationId));
        entityOf.set(m.observationId, m.entityId);
      }
      const reusable = new Map<number, string>();
      const reusedEntityIds = new Set<string>();
      result.clusters.forEach((cluster, index) => {
        const contributors = new Set(cluster.members.map((id) => entityOf.get(id)).filter((e): e is string => e !== undefined));
        if (contributors.size !== 1) return;
        const [only] = [...contributors] as [string];
        const before = membersOf.get(only) ?? new Set();
        const after = new Set(cluster.members);
        if ([...before].every((id) => after.has(id)) && !reusedEntityIds.has(only)) {
          reusable.set(index, only);
          reusedEntityIds.add(only);
        }
      });
      const keptObservationIds = new Set<string>();
      for (const [index, entityId] of reusable) {
        for (const id of result.clusters[index]?.members ?? []) if (membersOf.get(entityId)?.has(id)) keptObservationIds.add(id);
      }
      const supersededIds = ids.filter((id) => !keptObservationIds.has(id));
      if (supersededIds.length > 0) {
        await tx.$executeRaw`
          UPDATE "EntityMember" SET "supersededAt" = ${now}, "supersededBy" = ${runRow.id}
          WHERE "observationId" = ANY(${supersededIds}::text[]) AND "supersededAt" IS NULL AND "addedBy" = 'SYSTEM'`;
      }
      const previousEntityIds = [...membersOf.keys()].filter((id) => !reusedEntityIds.has(id));
      if (previousEntityIds.length > 0) {
        await tx.$executeRaw`
          UPDATE "Entity" SET "status" = 'UNRESOLVED'
          WHERE "id" = ANY(${previousEntityIds}::text[])
            AND NOT EXISTS (SELECT 1 FROM "EntityMember" m WHERE m."entityId" = "Entity"."id" AND m."supersededAt" IS NULL)`;
      }

      const entities: RunSummary["entities"] = [];
      const entityRows = result.clusters.map((cluster, index) => ({
        id: reusable.get(index) ?? `ent_${randomUUID().replace(/-/g, "")}`,
        kind: entityKind,
        canonicalLabel: cluster.label,
        status: cluster.status,
        lastResolvedAt: now,
        resolutionRunId: runRow.id,
      }));
      const fresh = entityRows.filter((_, index) => !reusable.has(index));
      for (let i = 0; i < fresh.length; i += BATCH) await tx.entity.createMany({ data: fresh.slice(i, i + BATCH) });
      for (const [index, entityId] of reusable) {
        const cluster = result.clusters[index] as (typeof result.clusters)[number];
        await tx.entity.update({ where: { id: entityId }, data: { canonicalLabel: cluster.label, status: cluster.status, lastResolvedAt: now, resolutionRunId: runRow.id } });
      }
      // Memberships that survived are left as they were; only what moved is written.
      const memberRows = result.clusters.flatMap((cluster, index) =>
        cluster.members
          .filter((observationId) => !keptObservationIds.has(observationId))
          .map((observationId) => ({
            entityId: (entityRows[index] as { id: string }).id,
            observationId,
            scoreBp: cluster.members.length === 1 ? 10_000 : (bestMatch.get(observationId) ?? 0),
            method: "fellegi-sunter",
            addedBy: "SYSTEM" as const,
            addedByActor: operator,
          })),
      );
      for (let i = 0; i < memberRows.length; i += BATCH) await tx.entityMember.createMany({ data: memberRows.slice(i, i + BATCH) });
      result.clusters.forEach((cluster, index) => {
        entities.push({ id: (entityRows[index] as { id: string }).id, status: cluster.status, label: cluster.label, members: cluster.members });
      });

      await tx.resolutionRun.update({
        where: { id: runRow.id },
        data: { status: "COMPLETE", finishedAt: new Date(), pairsEvaluated: decisionCount },
      });

      return { runId: runRow.id, entities };
    },
    { maxWait: 30_000, timeout: resolutionTimeoutMs() },
  );

  await recordAuditEvent({
    caseId,
    action: "v2.resolution.ran",
    actor: operator,
    detail: {
      runId: summary.runId,
      authorizationId: ctx.authorizationId,
      entityKind,
      modelVersion: result.model_version,
      ...result.counts,
    },
  });

  return {
    runId: summary.runId,
    entityKind,
    modelVersion: result.model_version,
    normalizationVersion: result.normalization_version,
    thresholds: { matchBp: result.thresholds.match_bp, reviewBp: result.thresholds.review_bp },
    counts: result.counts,
    entities: summary.entities,
  };
}

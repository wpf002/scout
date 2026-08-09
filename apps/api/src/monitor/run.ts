import type { InfraObservation, Source, Subject } from "@scout/sources";
import { observationKey, requiresScopeFor } from "@scout/sources";
import { prisma, recordAuditEvent } from "@scout/db";
import { getInfraAdapter } from "../adapters/infra/index.js";
import { getDatasetAdapter } from "../adapters/datasets/index.js";
import { executeUnscopedSource } from "../adapters/base.js";
import { badRequest } from "../errors.js";

export interface MonitorAdapter {
  source: Source;
  run: (subject: Subject) => Promise<unknown[]>;
}

/** Monitors draw from the ungated tiers only. Never from `scoped/`. */
export function monitorAdapterFor(sourceId: string): MonitorAdapter | undefined {
  return getInfraAdapter(sourceId) ?? getDatasetAdapter(sourceId);
}

/**
 * Validates the sources a monitor may watch.
 *
 * The check is the effective per-subject-kind gate, not the source's blanket
 * flag — so Intelligence X can be monitored for a domain and never for an
 * email selector. Rejecting at creation rather than at run time means an
 * unwatchable monitor cannot exist in the database at all.
 */
export function assertMonitorable(
  sourceIds: readonly string[],
  subject: Subject,
): MonitorAdapter[] {
  const adapters: MonitorAdapter[] = [];

  for (const sourceId of sourceIds) {
    const adapter = monitorAdapterFor(sourceId);
    if (adapter === undefined) {
      throw badRequest(
        `"${sourceId}" has no adapter, or is a person-facing source. ` +
          "Monitors draw only from the infrastructure and dataset tiers.",
      );
    }
    if (requiresScopeFor(adapter.source, subject.kind)) {
      throw badRequest(
        `${adapter.source.name} is scope-gated for a ${subject.kind} subject and cannot be monitored. ` +
          "Person-facing lookups run one confirmed action at a time; a standing " +
          "automated watch is the opposite of that.",
      );
    }
    if (!adapter.source.accepts.includes(subject.kind)) {
      throw badRequest(
        `${adapter.source.name} does not accept a ${subject.kind} subject.`,
      );
    }
    adapters.push(adapter);
  }

  if (adapters.length === 0) {
    throw badRequest("A monitor needs at least one source.");
  }
  return adapters;
}

/** A stable key + a readable summary for one observation. */
function describe(observation: unknown): {
  kind: string;
  key: string;
  detail: Record<string, unknown>;
} | null {
  if (observation === null || typeof observation !== "object") return null;
  const record = observation as Record<string, unknown>;
  const kind = typeof record["kind"] === "string" ? record["kind"] : null;
  if (kind === null) return null;

  // Infra observations already have a canonical identity function; reusing it
  // means the monitor and the board agree on what "the same thing" is.
  if (kind === "subdomain" || kind === "host" || kind === "cert") {
    return {
      kind,
      key: observationKey(observation as InfraObservation),
      detail: record,
    };
  }
  if (kind === "dataset-hit") {
    return {
      kind,
      key: `dataset-hit:${String(record["datasetId"])}:${String(record["title"])}`,
      detail: record,
    };
  }
  if (kind === "sanction-match") {
    return {
      kind,
      key: `sanction-match:${String(record["entityId"])}`,
      detail: record,
    };
  }
  return null;
}

export interface MonitorRunResult {
  runId: string;
  observationCount: number;
  added: number;
  removed: number;
  /** True when this run had no predecessor, so nothing is reported as new. */
  baseline: boolean;
  errors: { sourceId: string; message: string }[];
}

/**
 * Runs one monitor and records what changed.
 *
 * The first run is a **baseline**: it stores the snapshot and reports no
 * changes. Treating everything visible on day one as "newly appeared" would
 * bury the first real change under a hundred false ones, which is how an alert
 * feed becomes something people stop reading.
 *
 * Every underlying call still goes through `executeUnscopedSource`, so a
 * monitored query is audit-logged exactly like a manual one. A recurring
 * lookup is not a lesser event than a one-off.
 */
export async function runMonitor(
  monitorId: string,
  operator: string,
): Promise<MonitorRunResult> {
  const monitor = await prisma.monitor.findUnique({ where: { id: monitorId } });
  if (monitor === null) throw badRequest(`No monitor ${monitorId}.`);

  const subject: Subject = {
    kind: monitor.subjectKind.toLowerCase() as Subject["kind"],
    value: monitor.subjectValue,
  };

  // Re-validated on every run, not just at creation: the registry can change
  // under a stored monitor, and a source that becomes gated must stop being
  // watched rather than keep running under an old decision.
  const adapters = assertMonitorable(monitor.sourceIds, subject);

  const previous = await prisma.monitorRun.findFirst({
    where: { monitorId, errorMessage: null },
    orderBy: { startedAt: "desc" },
  });

  const startedAt = Date.now();
  const seen = new Map<string, { kind: string; detail: Record<string, unknown>; sourceIds: string[] }>();
  const errors: { sourceId: string; message: string }[] = [];

  for (const adapter of adapters) {
    const result = await executeUnscopedSource(
      adapter.source,
      { caseId: monitor.caseId, subject, operator },
      adapter.run,
    );

    if (result.status !== "ok") {
      if (result.status === "error") {
        errors.push({
          sourceId: adapter.source.id,
          message: result.message ?? "upstream error",
        });
      }
      continue;
    }

    for (const observation of (result.data ?? []) as unknown[]) {
      const described = describe(observation);
      if (described === null) continue;
      const existing = seen.get(described.key);
      if (existing === undefined) {
        seen.set(described.key, {
          kind: described.kind,
          detail: described.detail,
          sourceIds: [adapter.source.id],
        });
      } else if (!existing.sourceIds.includes(adapter.source.id)) {
        existing.sourceIds.push(adapter.source.id);
      }
    }
  }

  const currentKeys = [...seen.keys()].sort();
  const previousKeys = new Set(
    Array.isArray(previous?.snapshot) ? (previous.snapshot as string[]) : [],
  );
  const baseline = previous === null;

  const added = baseline
    ? []
    : currentKeys.filter((key) => !previousKeys.has(key));
  const removed = baseline
    ? []
    : [...previousKeys].filter((key) => !seen.has(key));

  // A run that reached no source successfully is not evidence that everything
  // disappeared. Recording those removals would raise an alert storm out of an
  // outage.
  const upstreamAllFailed = errors.length === adapters.length;
  const safeRemoved = upstreamAllFailed ? [] : removed;

  const run = await prisma.monitorRun.create({
    data: {
      monitorId,
      caseId: monitor.caseId,
      // On a total failure, carry the previous snapshot forward rather than
      // storing an empty one that would make the next run look like a flood
      // of additions.
      snapshot: upstreamAllFailed
        ? ((previous?.snapshot ?? []) as string[])
        : currentKeys,
      observationCount: seen.size,
      changeCount: added.length + safeRemoved.length,
      durationMs: Date.now() - startedAt,
      errorMessage:
        errors.length === 0
          ? null
          : errors.map((e) => `${e.sourceId}: ${e.message}`).join("; "),
    },
  });

  if (added.length > 0 || safeRemoved.length > 0) {
    await prisma.monitorChange.createMany({
      data: [
        ...added.map((key) => {
          const entry = seen.get(key);
          return {
            monitorId,
            runId: run.id,
            caseId: monitor.caseId,
            changeType: "ADDED" as const,
            observationKind: entry?.kind ?? "unknown",
            observationKey: key,
            detail: (entry?.detail ?? {}) as object,
            sourceIds: entry?.sourceIds ?? [],
          };
        }),
        ...safeRemoved.map((key) => ({
          monitorId,
          runId: run.id,
          caseId: monitor.caseId,
          changeType: "REMOVED" as const,
          observationKind: key.split(":")[0] ?? "unknown",
          observationKey: key,
          detail: {},
          sourceIds: [],
        })),
      ],
    });
  }

  await prisma.monitor.update({
    where: { id: monitorId },
    data: { lastRunAt: new Date() },
  });

  if (baseline) {
    await recordAuditEvent({
      caseId: monitor.caseId,
      action: "monitor.baseline",
      actor: operator,
      detail: { monitorId, observations: seen.size },
    });
  }

  return {
    runId: run.id,
    observationCount: seen.size,
    added: added.length,
    removed: safeRemoved.length,
    baseline,
    errors,
  };
}

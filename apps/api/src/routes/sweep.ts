import type { Source, SourceResult, Subject } from "@scout/sources";
import { requiresScopeFor } from "@scout/sources";
import { executeUnscopedSource } from "../adapters/base.js";
import { badRequest } from "../errors.js";
import { config } from "../config.js";

export interface SweepableAdapter<T> {
  source: Source;
  run: (subject: Subject) => Promise<T[]>;
}

export interface SweepExclusion {
  sourceId: string;
  name: string;
  reason: "scope-gated" | "kind-not-accepted";
  message: string;
}

export interface SweepOutcome<T> {
  ran: { adapter: SweepableAdapter<T>; result: SourceResult<T[]> }[];
  excluded: SweepExclusion[];
}

/**
 * Shared batch execution for non-scoped sources.
 *
 * Invariant 2 permits batching infra and dataset sources on an explicit
 * action. What it never permits is a person-facing source being swept, so the
 * filter here is the effective per-subject-kind gate — not the source's
 * blanket `requiresScope` flag. A source that is free for domains and gated
 * for email is swept with a domain and excluded with an email.
 *
 * Exclusions are returned, never silently dropped. A sweep that quietly
 * omitted a source would read as "covered everything" when it did not, and an
 * investigator would draw a conclusion from an absence that was really a
 * refusal.
 */
export async function runSweep<T>(
  adapters: readonly SweepableAdapter<T>[],
  subject: Subject,
  caseId: string,
): Promise<SweepOutcome<T>> {
  const excluded: SweepExclusion[] = [];
  const runnable: SweepableAdapter<T>[] = [];

  for (const adapter of adapters) {
    if (!adapter.source.accepts.includes(subject.kind)) {
      excluded.push({
        sourceId: adapter.source.id,
        name: adapter.source.name,
        reason: "kind-not-accepted",
        message: `Accepts ${adapter.source.accepts.join(" or ")}, not ${subject.kind}.`,
      });
      continue;
    }

    if (requiresScopeFor(adapter.source, subject.kind)) {
      excluded.push({
        sourceId: adapter.source.id,
        name: adapter.source.name,
        reason: "scope-gated",
        message:
          `${adapter.source.name} is scope-gated for a ${subject.kind} subject, ` +
          "so it is never swept. Run it on its own, as a confirmed action.",
      });
      continue;
    }

    runnable.push(adapter);
  }

  if (runnable.length === 0 && excluded.length > 0) {
    throw badRequest(
      `Nothing to sweep for a ${subject.kind} subject. ` +
        excluded.map((e) => `${e.sourceId}: ${e.message}`).join(" "),
    );
  }

  const ran = await Promise.all(
    runnable.map(async (adapter) => ({
      adapter,
      result: (await executeUnscopedSource(
        adapter.source,
        { caseId, subject, operator: config.SCOUT_OPERATOR },
        adapter.run,
      )) as SourceResult<T[]>,
    })),
  );

  return { ran, excluded };
}

/** Per-source reporting shared by both sweep routes. */
export function sweepSourceReport<T>(
  outcome: SweepOutcome<T>,
): {
  sourceId: string;
  name: string;
  status: string;
  reason: string | null;
  message: string | null;
  observationCount: number;
  queryLogId: string | null;
}[] {
  return outcome.ran.map(({ adapter, result }) => ({
    sourceId: adapter.source.id,
    name: adapter.source.name,
    status: result.status,
    reason: result.reason ?? null,
    message: result.message ?? null,
    observationCount: result.status === "ok" ? (result.data ?? []).length : 0,
    queryLogId: result.provenance.queryLogId ?? null,
  }));
}

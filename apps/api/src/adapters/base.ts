import type { Source, SourceResult, Subject } from "@scout/sources";
import { hasKey, makeProvenance } from "@scout/sources";
import type { ScopeEntry } from "@scout/scope";
import { ScopeError, enforceScope } from "@scout/scope";
import { loadCaseWithScope, recordQuery } from "@scout/db";
import { notFound } from "../errors.js";

export interface ScopedRunContext {
  caseId: string;
  subject: Subject;
  operator: string;
}

/**
 * The template every `requiresScope` adapter runs inside.
 *
 * The ordering here is the whole point, and it is deliberate:
 *
 *   1. Load the case. No case, no scoped execution — ever.
 *   2. Enforce scope BEFORE anything else, including the key check. An
 *      out-of-scope attempt must be recorded as denied whether or not the
 *      source could have run.
 *   3. Log the denial, then rethrow. A denial that is not written down is the
 *      failure mode this whole layer exists to prevent.
 *   4. Only then check the key, and only then make the network call.
 *
 * `run` receives the subject and does nothing but talk to the upstream. It
 * cannot be reached for an out-of-scope subject because the throw in step 3
 * happens first (locked invariant 1).
 */
export async function executeScopedSource<T>(
  source: Source,
  ctx: ScopedRunContext,
  run: (subject: Subject) => Promise<T>,
): Promise<SourceResult<T>> {
  const loaded = await loadCaseWithScope(ctx.caseId);
  if (loaded === null) {
    throw notFound(`Case ${ctx.caseId} does not exist.`);
  }

  const { record, scope } = loaded;

  let matchedScope: ScopeEntry;
  try {
    matchedScope = enforceScope({
      subject: ctx.subject,
      scope,
      source,
      caseId: record.id,
      authorizationRef: record.authorizationRef,
    });
  } catch (error) {
    if (error instanceof ScopeError) {
      await recordQuery({
        caseId: record.id,
        source,
        subject: ctx.subject,
        phase: "EXECUTE",
        outcome: "DENIED",
        reason: error.reason,
        authorizationRef: record.authorizationRef,
        operator: ctx.operator,
      });
    }
    throw error;
  }

  if (!hasKey(source)) {
    const log = await recordQuery({
      caseId: record.id,
      source,
      subject: ctx.subject,
      phase: "EXECUTE",
      outcome: "INERT",
      authorizationRef: record.authorizationRef,
      operator: ctx.operator,
      matchedScope,
    });
    return {
      status: "inert",
      reason: "missing-key",
      message: `${source.name} has no API key configured (${source.keyEnv}). No request was made.`,
      provenance: makeProvenance(source, ctx.subject.value, ctx.subject.kind, {
        queryLogId: log.id,
      }),
    };
  }

  const startedAt = Date.now();
  try {
    const data = await run(ctx.subject);
    const log = await recordQuery({
      caseId: record.id,
      source,
      subject: ctx.subject,
      phase: "EXECUTE",
      outcome: "ALLOWED",
      authorizationRef: record.authorizationRef,
      operator: ctx.operator,
      matchedScope,
      durationMs: Date.now() - startedAt,
    });
    return {
      status: "ok",
      data,
      provenance: makeProvenance(source, ctx.subject.value, ctx.subject.kind, {
        queryLogId: log.id,
      }),
    };
  } catch (error) {
    // Adapters degrade; they do not take the request down with them.
    const message = error instanceof Error ? error.message : String(error);
    const log = await recordQuery({
      caseId: record.id,
      source,
      subject: ctx.subject,
      phase: "EXECUTE",
      outcome: "ERROR",
      authorizationRef: record.authorizationRef,
      operator: ctx.operator,
      matchedScope,
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    });
    return {
      status: "error",
      reason: "upstream-error",
      message: `${source.name} could not be reached.`,
      provenance: makeProvenance(source, ctx.subject.value, ctx.subject.kind, {
        queryLogId: log.id,
      }),
    };
  }
}

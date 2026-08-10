import type { Source, SourceResult, Subject } from "@scout/sources";
import { hasKey, makeProvenance, requiresScopeFor } from "@scout/sources";
import { isBinaryAvailable } from "./cli/run.js";
import type { ScopeEntry } from "@scout/scope";
import { ScopeError, enforceScope } from "@scout/scope";
import { loadCaseWithScope, recordQuery } from "@scout/db";
import { notFound } from "../errors.js";
import { config } from "../config.js";

import { TtlCache, responseCacheKey } from "../lib/cache.js";
import { infraRateLimiter } from "../lib/ratelimit.js";

/**
 * The CLI counterpart to `hasKey`.
 *
 * A `cli` source depends on a program being installed rather than a key being
 * set, and the two failures deserve the same treatment: report `inert`, run
 * nothing, guess nothing (locked invariant 6). Sources with no `binary` are
 * trivially available.
 */
async function hasBinary(source: Source): Promise<boolean> {
  if (source.binary === undefined) return true;
  return isBinaryAvailable(source.binary);
}

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
    // An instance configured as authorized for everything skips the match but
    // not the record. The audit row still lands, marked so that a reader can
    // tell "this matched a scope entry" from "this instance was configured to
    // allow anything" — collapsing those two would make the log unable to
    // answer the question it exists for.
    matchedScope = config.SCOUT_AUTHORIZE_ALL
      ? {
          kind: "identifier",
          value: ctx.subject.value,
        }
      : enforceScope({
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

  if (!(await hasBinary(source))) {
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
      reason: "missing-binary",
      message: `${source.name} is not installed (${source.binary} is not on PATH). Nothing was run.`,
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

/** Shared short-TTL cache for non-scoped upstream responses. */
const responseCache = new TtlCache<unknown>({ ttlMs: 300_000, maxEntries: 500 });

/** Exposed so tests can start from a clean cache. */
export function clearResponseCache(): void {
  responseCache.clear();
}

/**
 * The runner for sources that are NOT scope-gated — infrastructure and
 * datasets. These look at hosts, certificates and public records rather than
 * at a person, which is why they carry no scope gate.
 *
 * That makes this function a potential bypass, so it refuses outright to run
 * anything marked `requiresScope`. Routing a scoped source through here must
 * fail loudly at the first call rather than quietly skip `enforceScope()`.
 *
 * Executions are still audit-logged. Locked invariant 3 only requires it for
 * scoped queries, but recording every outbound call costs one row and gives
 * Phase 7 a complete investigation timeline. Plan-phase rows stay scoped-only,
 * because a plan that merely lists a deeplink is not an event worth keeping.
 */
export async function executeUnscopedSource<T>(
  source: Source,
  ctx: ScopedRunContext,
  run: (subject: Subject) => Promise<T>,
): Promise<SourceResult<T>> {
  // Checked against the effective gate for this subject kind, not the
  // source's blanket flag — otherwise a per-kind gated source (Intelligence X
  // with an email selector) would slip through on the unscoped path.
  if (requiresScopeFor(source, ctx.subject.kind)) {
    throw new Error(
      `${source.id} requires scope for a ${ctx.subject.kind} subject and must run ` +
        "through executeScopedSource(). Refusing to execute it on the unscoped path.",
    );
  }

  const loaded = await loadCaseWithScope(ctx.caseId);
  if (loaded === null) {
    throw notFound(`Case ${ctx.caseId} does not exist.`);
  }
  const { record } = loaded;

  const provenanceFor = (queryLogId?: string) =>
    makeProvenance(source, ctx.subject.value, ctx.subject.kind, {
      ...(queryLogId === undefined ? {} : { queryLogId }),
    });

  if (!hasKey(source)) {
    const log = await recordQuery({
      caseId: record.id,
      source,
      subject: ctx.subject,
      phase: "EXECUTE",
      outcome: "INERT",
      reason: "missing-key",
      authorizationRef: record.authorizationRef,
      operator: ctx.operator,
    });
    return {
      status: "inert",
      reason: "missing-key",
      message: `${source.name} has no API key configured (${source.keyEnv}). No request was made.`,
      provenance: provenanceFor(log.id),
    };
  }

  if (!(await hasBinary(source))) {
    const log = await recordQuery({
      caseId: record.id,
      source,
      subject: ctx.subject,
      phase: "EXECUTE",
      outcome: "INERT",
      reason: "missing-binary",
      authorizationRef: record.authorizationRef,
      operator: ctx.operator,
    });
    return {
      status: "inert",
      reason: "missing-binary",
      message: `${source.name} is not installed (${source.binary} is not on PATH). Nothing was run.`,
      provenance: provenanceFor(log.id),
    };
  }

  const cacheKey = responseCacheKey(
    source.id,
    ctx.subject.kind,
    ctx.subject.value,
  );
  const cached = responseCache.get(cacheKey);
  if (cached !== undefined) {
    const log = await recordQuery({
      caseId: record.id,
      source,
      subject: ctx.subject,
      phase: "EXECUTE",
      outcome: "ALLOWED",
      reason: "cache-hit",
      authorizationRef: record.authorizationRef,
      operator: ctx.operator,
      durationMs: 0,
    });
    return {
      status: "ok",
      data: cached as T,
      provenance: provenanceFor(log.id),
    };
  }

  if (!(await infraRateLimiter.acquire(source.id))) {
    const log = await recordQuery({
      caseId: record.id,
      source,
      subject: ctx.subject,
      phase: "EXECUTE",
      outcome: "ERROR",
      reason: "rate-limited",
      authorizationRef: record.authorizationRef,
      operator: ctx.operator,
    });
    return {
      status: "error",
      reason: "rate-limited",
      message: `${source.name} is rate limited right now. Nothing was sent; try again shortly.`,
      provenance: provenanceFor(log.id),
    };
  }

  const startedAt = Date.now();
  try {
    const data = await run(ctx.subject);
    responseCache.set(cacheKey, data);
    const log = await recordQuery({
      caseId: record.id,
      source,
      subject: ctx.subject,
      phase: "EXECUTE",
      outcome: "ALLOWED",
      authorizationRef: record.authorizationRef,
      operator: ctx.operator,
      durationMs: Date.now() - startedAt,
    });
    return { status: "ok", data, provenance: provenanceFor(log.id) };
  } catch (error) {
    // Adapters degrade to a reported error; they never take the request down.
    const message = error instanceof Error ? error.message : String(error);
    const log = await recordQuery({
      caseId: record.id,
      source,
      subject: ctx.subject,
      phase: "EXECUTE",
      outcome: "ERROR",
      reason: "upstream-error",
      authorizationRef: record.authorizationRef,
      operator: ctx.operator,
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    });
    return {
      status: "error",
      reason: "upstream-error",
      message: `${source.name} could not be reached.`,
      provenance: provenanceFor(log.id),
    };
  }
}

/**
 * Picks the right runner for a (source, subject) pair.
 *
 * Routes should call this rather than choosing a runner themselves: the choice
 * depends on the effective per-subject-kind gate, and getting it wrong in one
 * route is precisely how a person-facing lookup ends up ungated. Intelligence
 * X routes here to the unscoped runner for a domain and the scoped one for an
 * email selector, with no branch in the route at all.
 *
 * Note the scoped path deliberately has no response cache. Holding
 * person-facing results in process memory is a data-minimization question, not
 * a performance one, and the conservative default is not to.
 */
export function executeSource<T>(
  source: Source,
  ctx: ScopedRunContext,
  run: (subject: Subject) => Promise<T>,
): Promise<SourceResult<T>> {
  return requiresScopeFor(source, ctx.subject.kind)
    ? executeScopedSource(source, ctx, run)
    : executeUnscopedSource(source, ctx, run);
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SOURCES,
  hasKey,
  requiresScopeFor,
  serializeSource,
  subjectSchema,
  tierSchema,
  type Source,
  type Subject,
} from "@scout/sources";
import { checkScope, envScope, type ScopeEntry } from "@scout/scope";
import { loadCaseWithScope, prisma, recordQuery } from "@scout/db";
import { INFRA_ADAPTERS } from "../adapters/infra/index.js";
import { DATASET_ADAPTERS } from "../adapters/datasets/index.js";
import {
  SCOPED_ADAPTERS,
  scopedRoutePath,
} from "../adapters/scoped/index.js";
import { notFound } from "../errors.js";
import { operatorOf } from "../auth.js";

/**
 * Where an executable source is actually run. A source with no entry here
 * plans as `no-adapter`, which the UI shows plainly rather than pretending
 * the source is ready.
 *
 * Infra entries are derived from the adapter registry so the two cannot drift:
 * building an adapter is what makes a source runnable, not editing a map.
 */
export const EXECUTION_ROUTES: Record<string, string> = {
  ...Object.fromEntries(
    SCOPED_ADAPTERS.map((adapter) => [
      adapter.source.id,
      scopedRoutePath(adapter.source),
    ]),
  ),
  ...Object.fromEntries(
    INFRA_ADAPTERS.map((adapter) => [
      adapter.source.id,
      `/infra/${adapter.source.id}`,
    ]),
  ),
  ...Object.fromEntries(
    DATASET_ADAPTERS.map((adapter) => [
      adapter.source.id,
      `/datasets/${adapter.source.id}`,
    ]),
  ),
};

const planRequestSchema = z.object({
  subject: subjectSchema,
  /** Required for any scoped source to be plannable as runnable. */
  caseId: z.string().min(1).optional(),
  tiers: z.array(tierSchema).nonempty().optional(),
  sourceIds: z.array(z.string().min(1)).nonempty().optional(),
});

type PlanStatus = "deeplink" | "ready" | "inert" | "blocked" | "no-adapter";

interface PlanEntry {
  sourceId: string;
  name: string;
  tier: string;
  mode: string;
  requiresScope: boolean;
  status: PlanStatus;
  /** Present only for deeplink sources. The CLIENT opens this, not Scout. */
  url?: string;
  reason?: string;
  message?: string;
  /** Which scope entry authorized this, so the UI can show the basis. */
  matchedScope?: ScopeEntry;
  execution?: {
    method: "POST";
    path: string;
    /**
     * Scoped sources are always one confirmed action at a time — never a
     * batch, never implicit (locked invariant 2).
     */
    requiresConfirmation: true;
  };
}

function planNonScoped(source: Source, subject: Subject): PlanEntry {
  const base = {
    sourceId: source.id,
    name: source.name,
    tier: source.tier,
    mode: source.mode,
    requiresScope: false as const,
  };

  // A source may offer a link even when Scout can also fetch it (crt.sh does),
  // so the link is computed independently of the mode. Building it makes no
  // network request — it only formats a string.
  const link = source.deeplink?.(subject.value);
  const withLink = link === undefined ? {} : { url: link };

  if (source.mode === "deeplink") {
    return {
      ...base,
      status: "deeplink",
      // Handed to the investigator to open. Scout does not fetch it — the
      // subject term never touches a Scout-owned call for a deeplink source
      // (locked invariant 4).
      url: link ?? source.homepage,
    };
  }

  if (!hasKey(source)) {
    return {
      ...base,
      ...withLink,
      status: "inert",
      reason: "missing-key",
      message: `No API key configured (${source.keyEnv}).`,
    };
  }

  const path = EXECUTION_ROUTES[source.id];
  if (path === undefined) {
    return {
      ...base,
      ...withLink,
      status: "no-adapter",
      reason: "adapter-not-built",
      message: `${source.name} has a key but no adapter yet.`,
    };
  }

  return {
    ...base,
    ...withLink,
    status: "ready",
    execution: { method: "POST", path, requiresConfirmation: true },
  };
}

function planScoped(
  source: Source,
  subject: Subject,
  scope: readonly ScopeEntry[],
  caseId: string | undefined,
): PlanEntry {
  const base = {
    sourceId: source.id,
    name: source.name,
    tier: source.tier,
    mode: source.mode,
    requiresScope: true as const,
  };

  if (caseId === undefined) {
    return {
      ...base,
      status: "blocked",
      reason: "case-required",
      message:
        "Scoped sources only run inside a case with an authorization reference.",
    };
  }

  const decision = checkScope(subject, scope);
  if (!decision.allowed) {
    return {
      ...base,
      status: "blocked",
      reason: decision.reason,
      message: decision.message,
    };
  }

  if (!hasKey(source)) {
    return {
      ...base,
      status: "inert",
      reason: "missing-key",
      message: `In scope, but no API key configured (${source.keyEnv}).`,
      matchedScope: decision.matched,
    };
  }

  const path = EXECUTION_ROUTES[source.id];
  if (path === undefined) {
    return {
      ...base,
      status: "no-adapter",
      reason: "adapter-not-built",
      message: `${source.name} is in scope but its adapter is not built yet.`,
    };
  }

  return {
    ...base,
    status: "ready",
    matchedScope: decision.matched,
    execution: { method: "POST", path, requiresConfirmation: true },
  };
}

/** Plan status → the audit outcome recorded for that PLAN row. */
function planOutcome(status: PlanStatus) {
  if (status === "blocked") return "DENIED" as const;
  if (status === "inert" || status === "no-adapter") return "INERT" as const;
  return "ALLOWED" as const;
}

export async function registerQueryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /query — plans, and only plans.
   *
   * This endpoint never executes a source. It returns what *could* be run and
   * what is blocked and why. There is deliberately no endpoint that takes a
   * name and returns an assembled dossier (locked invariant 2).
   */
  app.post("/query", async (request) => {
    const body = planRequestSchema.parse(request.body);
    const subject: Subject = body.subject;

    let scope: readonly ScopeEntry[] = [];
    let authorizationRef: string | null = null;
    let disabledSourceIds = new Set<string>();

    if (body.caseId !== undefined) {
      const loaded = await loadCaseWithScope(body.caseId);
      if (loaded === null) throw notFound(`Case ${body.caseId} does not exist.`);
      scope = loaded.scope;
      authorizationRef = loaded.record.authorizationRef;

      const disabled = await prisma.caseSource.findMany({
        where: { caseId: body.caseId, enabled: false },
        select: { sourceId: true },
      });
      disabledSourceIds = new Set(disabled.map((row) => row.sourceId));
    } else {
      // Keyless local fallback. Good enough to preview a plan; never enough to
      // execute a scoped source — that path requires a case.
      scope = envScope();
    }

    const tiers = body.tiers === undefined ? null : new Set<string>(body.tiers);
    const ids = body.sourceIds === undefined ? null : new Set(body.sourceIds);

    const candidates = SOURCES.filter((source) => {
      if (!source.accepts.includes(subject.kind)) return false;
      if (tiers !== null && !tiers.has(source.tier)) return false;
      if (ids !== null && !ids.has(source.id)) return false;
      if (disabledSourceIds.has(source.id)) return false;
      return true;
    });

    // Gated per subject kind, not per source: Intelligence X is dataset
    // research for a domain and a person lookup for an email selector.
    const plan = candidates.map((source) =>
      requiresScopeFor(source, subject.kind)
        ? planScoped(source, subject, scope, body.caseId)
        : planNonScoped(source, subject),
    );

    // Every scoped source considered under a case gets an audit row, whether
    // it planned as runnable or blocked. Planning is an attempt too.
    if (body.caseId !== undefined && authorizationRef !== null) {
      const caseId = body.caseId;
      const ref = authorizationRef;
      await Promise.all(
        plan
          .filter((entry) => entry.requiresScope)
          .map((entry) => {
            const source = candidates.find((s) => s.id === entry.sourceId);
            if (source === undefined) return Promise.resolve(null);
            return recordQuery({
              caseId,
              source,
              subject,
              phase: "PLAN",
              outcome: planOutcome(entry.status),
              reason: entry.reason,
              authorizationRef: ref,
              operator: operatorOf(request),
              matchedScope: entry.matchedScope,
            });
          }),
      );
    }

    return {
      executed: false,
      note: "This is a plan. Nothing was run. Scoped sources require a separate, confirmed action.",
      subject,
      caseId: body.caseId ?? null,
      scopeSource: body.caseId === undefined ? "env-fallback" : "case",
      scopeEntryCount: scope.length,
      counts: {
        total: plan.length,
        deeplink: plan.filter((e) => e.status === "deeplink").length,
        ready: plan.filter((e) => e.status === "ready").length,
        inert: plan.filter((e) => e.status === "inert").length,
        blocked: plan.filter((e) => e.status === "blocked").length,
        noAdapter: plan.filter((e) => e.status === "no-adapter").length,
      },
      plan,
    };
  });

  /** GET /sources — the registry, in reach-for tier order. */
  app.get("/sources", async () => ({
    tierOrder: ["datasets", "infra", "exposure", "people", "onion", "utils"],
    count: SOURCES.length,
    sources: SOURCES.map((source) => ({
      ...serializeSource(source),
      keyed: hasKey(source),
      hasAdapter: EXECUTION_ROUTES[source.id] !== undefined,
    })),
  }));
}

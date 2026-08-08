import type { Source, Subject } from "@scout/sources";
import { SOURCES } from "@scout/sources";
import type { ScopeEntry } from "@scout/scope";
import type {
  Case,
  Prisma,
  QueryLog,
  QueryOutcome,
  QueryPhase,
} from "@prisma/client";
import { prisma } from "./client.js";
import {
  jsonSafe,
  toPrismaSubjectKind,
  toPrismaTier,
  toScopeEntry,
} from "./mappers.js";

export interface CaseWithScope {
  record: Case;
  scope: ScopeEntry[];
}

/**
 * Loads a case together with its scope entries.
 *
 * This is the Phase 1 replacement for env-derived scope: the gate now answers
 * "is this in scope?" against the rows owned by the case, so authorization
 * follows the engagement rather than the deployment.
 */
export async function loadCaseWithScope(
  caseId: string,
): Promise<CaseWithScope | null> {
  const record = await prisma.case.findUnique({
    where: { id: caseId },
    include: { scopeEntries: true },
  });
  if (record === null) return null;

  const { scopeEntries, ...rest } = record;
  return {
    record: rest as Case,
    scope: scopeEntries.map(toScopeEntry),
  };
}

/**
 * Every value that could be a live credential, gathered from the registry.
 * Used to scrub upstream error text before it reaches the audit log — a
 * provider that echoes the key back in a 401 body must not turn the audit
 * trail into a secret store.
 */
function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  for (const source of SOURCES) {
    if (source.keyEnv === null) continue;
    const value = env[source.keyEnv];
    // Very short values would scrub half the message; they are not real keys.
    if (typeof value === "string" && value.trim().length >= 8) {
      values.push(value.trim());
    }
  }
  return values;
}

/** Replaces any configured API key found in `message` with a marker. */
export function redactSecrets(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let out = message;
  for (const secret of secretValues(env)) {
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

export interface RecordQueryInput {
  caseId: string;
  source: Source;
  subject: Subject;
  phase: QueryPhase;
  outcome: QueryOutcome;
  /**
   * Why this outcome. A `DenyReason` from @scout/scope when DENIED; a cause
   * such as `missing-key` when INERT.
   */
  reason?: string | undefined;
  /** Snapshot of the case's auth ref at query time. */
  authorizationRef: string;
  operator?: string;
  /** The entry that authorized the query, snapshotted onto the audit row. */
  matchedScope?: ScopeEntry | undefined;
  errorMessage?: string | undefined;
  durationMs?: number | undefined;
}

/**
 * Writes one immutable audit row.
 *
 * Called for every scoped query attempt — planned or executed, allowed or
 * denied. A denial is the row that matters most: it is the evidence that the
 * gate held.
 */
export async function recordQuery(
  input: RecordQueryInput,
): Promise<QueryLog> {
  return prisma.queryLog.create({
    data: {
      caseId: input.caseId,
      sourceId: input.source.id,
      tier: toPrismaTier(input.source.tier),
      requiresScope: input.source.requiresScope,
      phase: input.phase,
      outcome: input.outcome,
      reason: input.reason ?? null,
      subjectKind: toPrismaSubjectKind(input.subject.kind),
      subjectValue: input.subject.value,
      authorizationRef: input.authorizationRef,
      operator: input.operator ?? process.env["SCOUT_OPERATOR"] ?? "local",
      matchedScopeEntryId: input.matchedScope?.id ?? null,
      matchedScopeValue: input.matchedScope?.value ?? null,
      errorMessage:
        input.errorMessage === undefined
          ? null
          : redactSecrets(input.errorMessage),
      durationMs: input.durationMs ?? null,
    },
  });
}

export interface RecordAuditEventInput {
  caseId?: string | undefined;
  action: string;
  detail?: unknown;
  actor?: string;
}

/**
 * Records a non-query case event. Scope edits go here: changing scope changes
 * what the tool is permitted to do, so it belongs in the record beside the
 * queries it authorizes.
 */
export async function recordAuditEvent(input: RecordAuditEventInput) {
  return prisma.auditEvent.create({
    data: {
      caseId: input.caseId ?? null,
      action: input.action,
      detail: (jsonSafe(input.detail ?? {}) ?? {}) as Prisma.InputJsonValue,
      actor: input.actor ?? process.env["SCOUT_OPERATOR"] ?? "local",
    },
  });
}

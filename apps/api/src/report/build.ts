import { TIERS, getSource } from "@scout/sources";
import type { Tier } from "@scout/sources";
import { redactOutOfScope, type Redaction } from "@scout/scope";
import { prisma, toScopeEntry } from "@scout/db";
import { collectSecretValues, scrubSecrets } from "./secrets.js";
import { notFound } from "../errors.js";

export interface ReportFinding {
  id: string;
  title: string;
  summary: string | null;
  sourceId: string;
  sourceName: string;
  queryTerm: string;
  queryKind: string;
  observedAt: string;
  savedBy: string;
  /** True when the finding traces back to a logged Scout call. */
  auditLinked: boolean;
}

export interface ReportTierGroup {
  tier: Tier;
  findings: ReportFinding[];
}

export interface TimelineEvent {
  at: string;
  kind: "query" | "finding" | "case";
  label: string;
  detail: string;
}

export interface AuditRow {
  at: string;
  phase: string;
  outcome: string;
  reason: string | null;
  sourceId: string;
  subjectKind: string;
  subjectValue: string;
  matchedScope: string | null;
  operator: string;
  requiresScope: boolean;
}

export interface CaseReport {
  generatedAt: string;
  case: {
    id: string;
    name: string;
    status: string;
    authorizationRef: string;
    notes: string;
    createdAt: string;
    createdBy: string;
  };
  scope: { kind: string; value: string; note: string | null }[];
  subjects: { kind: string; value: string; label: string | null }[];
  tiers: ReportTierGroup[];
  timeline: TimelineEvent[];
  audit: {
    rows: AuditRow[];
    totals: {
      total: number;
      allowed: number;
      denied: number;
      inert: number;
      error: number;
      scopedAttempts: number;
    };
  };
  redaction: {
    /** How many out-of-scope identifiers were stripped before export. */
    count: number;
    /** Kinds only — the values themselves are never exported. */
    kinds: string[];
    fields: string[];
    /**
     * How many credential values stored on this case were struck out of
     * free-text fields. Separate from `count` because it answers a different
     * question: not "was this target authorized" but "did a secret leak into
     * prose".
     */
    credentialsScrubbed: number;
  };
}

/**
 * Assembles everything a case report needs, in one place.
 *
 * Redaction happens here rather than in each renderer, so the HTML, the docx
 * and the JSON cannot disagree about what left the building. A renderer that
 * had to remember to redact would eventually forget.
 */
export async function buildCaseReport(caseId: string): Promise<CaseReport> {
  const record = await prisma.case.findUnique({
    where: { id: caseId },
    include: {
      scopeEntries: { orderBy: { createdAt: "asc" } },
      subjects: { orderBy: { createdAt: "asc" } },
      findings: { orderBy: { observedAt: "asc" } },
      queryLogs: { orderBy: { createdAt: "asc" } },
    },
  });
  if (record === null) throw notFound(`Case ${caseId} does not exist.`);

  const scope = record.scopeEntries.map(toScopeEntry);
  const redactions: Redaction[] = [];
  const redactedFields = new Set<string>();
  let credentialsScrubbed = 0;

  // Credential material this case has actually stored. Collected once, struck
  // from every free-text field below — a password typed into a note by hand is
  // invisible to scope-based redaction, because it is not an identifier.
  const secrets = collectSecretValues(record.findings.map((f) => f.data));

  const clean = (text: string | null, field: string): string => {
    const scoped = redactOutOfScope(text, scope);
    if (scoped.redactions.length > 0) {
      redactions.push(...scoped.redactions);
      redactedFields.add(field);
    }
    const scrubbed = scrubSecrets(scoped.text, secrets);
    if (scrubbed.count > 0) {
      credentialsScrubbed += scrubbed.count;
      redactedFields.add(field);
    }
    return scrubbed.text;
  };

  const findings: ReportFinding[] = record.findings.map((finding) => ({
    id: finding.id,
    title: clean(finding.title, "finding.title"),
    summary:
      finding.summary === null ? null : clean(finding.summary, "finding.summary"),
    sourceId: finding.sourceId,
    sourceName: getSource(finding.sourceId)?.name ?? finding.sourceId,
    queryTerm: finding.queryTerm,
    queryKind: finding.queryKind.toLowerCase(),
    observedAt: finding.observedAt.toISOString(),
    savedBy: finding.savedBy,
    auditLinked: finding.queryLogId !== null,
  }));

  const byTier = new Map<string, ReportFinding[]>();
  for (const finding of record.findings) {
    const key = finding.tier.toLowerCase();
    const built = findings.find((f) => f.id === finding.id);
    if (built === undefined) continue;
    byTier.set(key, [...(byTier.get(key) ?? []), built]);
  }

  // Grouped in reach-for order so the report reads the way the work was done.
  const tiers: ReportTierGroup[] = TIERS.map((tier) => ({
    tier,
    findings: byTier.get(tier) ?? [],
  })).filter((group) => group.findings.length > 0);

  const timeline: TimelineEvent[] = [
    {
      at: record.createdAt.toISOString(),
      kind: "case" as const,
      label: "Case opened",
      detail: `${record.name} under ${record.authorizationRef}`,
    },
    ...record.queryLogs.map((log) => ({
      at: log.createdAt.toISOString(),
      kind: "query" as const,
      label: `${log.phase} ${log.sourceId} → ${log.outcome}`,
      detail:
        log.outcome === "DENIED"
          ? `${log.subjectKind.toLowerCase()} refused (${log.reason})`
          : `${log.subjectKind.toLowerCase()} ${log.subjectValue}`,
    })),
    ...findings.map((finding) => ({
      at: finding.observedAt,
      kind: "finding" as const,
      label: `Finding saved from ${finding.sourceId}`,
      detail: finding.title,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const rows: AuditRow[] = record.queryLogs.map((log) => ({
    at: log.createdAt.toISOString(),
    phase: log.phase,
    outcome: log.outcome,
    reason: log.reason,
    sourceId: log.sourceId,
    subjectKind: log.subjectKind.toLowerCase(),
    subjectValue: log.subjectValue,
    matchedScope: log.matchedScopeValue,
    operator: log.operator,
    requiresScope: log.requiresScope,
  }));

  const count = (outcome: string) =>
    rows.filter((row) => row.outcome === outcome).length;

  return {
    generatedAt: new Date().toISOString(),
    case: {
      id: record.id,
      name: record.name,
      status: record.status,
      authorizationRef: record.authorizationRef,
      notes: clean(record.notes, "case.notes"),
      createdAt: record.createdAt.toISOString(),
      createdBy: record.createdBy,
    },
    scope: record.scopeEntries.map((entry) => ({
      kind: entry.kind.toLowerCase(),
      value: entry.value,
      note: entry.note,
    })),
    subjects: record.subjects.map((subject) => ({
      kind: subject.kind.toLowerCase(),
      value: subject.value,
      label: subject.label,
    })),
    tiers,
    timeline,
    audit: {
      rows,
      totals: {
        total: rows.length,
        allowed: count("ALLOWED"),
        denied: count("DENIED"),
        inert: count("INERT"),
        error: count("ERROR"),
        scopedAttempts: rows.filter((row) => row.requiresScope).length,
      },
    },
    redaction: {
      count: redactions.length,
      // Kinds only. Exporting the redacted values would defeat the redaction.
      kinds: [...new Set(redactions.map((r) => r.kind))].sort(),
      fields: [...redactedFields].sort(),
      credentialsScrubbed,
    },
  };
}

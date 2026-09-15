import type { ResultRow } from "./flatten";

/**
 * The correlated profile.
 *
 * The grouped table answers "what did each source say". It does not answer the
 * question an investigator actually starts with, which is "what is this thing".
 * Reading that off the table means holding twelve groups in your head and
 * noticing that three of them named the same registrar.
 *
 * So this does the noticing. It ranks by corroboration — how many independent
 * sources reported the same value — because one source saying something is a
 * claim and four sources saying it is a finding, and that distinction is the
 * whole of why a consolidating tool is worth building.
 *
 * It never invents a fact. Every line here traces back to rows that are already
 * on screen, and a value reported once is still shown as reported once.
 */

export interface Corroborated {
  type: string;
  value: string;
  detail: string;
  /** Independent sources reporting this exact value. */
  sources: string[];
  occurrences: number;
}

export interface Conflict {
  /** The fact that should have one answer. */
  field: string;
  /** What each source said it was. */
  claims: { value: string; sources: string[] }[];
}

export interface Profile {
  /** Values two or more independent sources agree on, best corroborated first. */
  corroborated: Corroborated[];
  /** Single-valued facts the sources disagree about. */
  conflicts: Conflict[];
  /** Headline figures. */
  reach: {
    sourcesAnswering: number;
    values: number;
    corroborated: number;
  };
  /** Identifiers worth pivoting to, deduplicated and ordered. */
  pivots: { type: string; value: string; sources: number }[];
}

/**
 * Groups that describe one property of the subject rather than a list of
 * related things. Two different answers here mean the sources disagree; two
 * different subdomains do not.
 */
const SINGLE_VALUED = new Set(["Registration", "Organization"]);

/** Groups whose values are themselves searchable indicators. */
const PIVOTABLE = new Set([
  "Hosts",
  "Subdomains",
  "Emails",
  "Profiles",
  "Organization",
  "Credentials",
]);

/**
 * Detail lines carry "key: value" for several adapters. Pulling the key out is
 * what makes a conflict detectable — two rows both saying "Registrar" are
 * comparable, two rows both saying "Registration" are not.
 */
function fieldOf(row: ResultRow): string {
  const match = /^([A-Za-z][A-Za-z \-/]{1,28}?)\s*[:=]/.exec(row.detail.trim());
  return match?.[1]?.trim() ?? row.type;
}

export function buildProfile(rows: ResultRow[]): Profile {
  const corroborated = rows
    .filter((row) => row.sources.length >= 2)
    .map((row) => ({
      type: row.type,
      value: row.value,
      detail: row.detail,
      sources: row.sources,
      occurrences: row.occurrences,
    }))
    .sort((a, b) => {
      if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
      return b.occurrences - a.occurrences;
    });

  // Conflicts: one field, more than one answer, within a single-valued group.
  const byField = new Map<string, Map<string, Set<string>>>();
  for (const row of rows) {
    if (!SINGLE_VALUED.has(row.type)) continue;
    const field = fieldOf(row);
    const claims = byField.get(field) ?? new Map<string, Set<string>>();
    const holders = claims.get(row.value) ?? new Set<string>();
    for (const source of row.sources) holders.add(source);
    claims.set(row.value, holders);
    byField.set(field, claims);
  }

  const conflicts: Conflict[] = [];
  for (const [field, claims] of byField) {
    if (claims.size < 2) continue;
    conflicts.push({
      field,
      claims: [...claims.entries()]
        .map(([value, sources]) => ({ value, sources: [...sources].sort() }))
        .sort((a, b) => b.sources.length - a.sources.length),
    });
  }

  const seen = new Set<string>();
  const pivots: Profile["pivots"] = [];
  for (const row of [...rows].sort((a, b) => b.sources.length - a.sources.length)) {
    if (!PIVOTABLE.has(row.type)) continue;
    const key = row.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pivots.push({ type: row.type, value: row.value, sources: row.sources.length });
  }

  const sourcesAnswering = new Set(rows.flatMap((row) => row.sources)).size;

  return {
    corroborated,
    conflicts,
    reach: {
      sourcesAnswering,
      values: rows.length,
      corroborated: corroborated.length,
    },
    pivots: pivots.slice(0, 24),
  };
}

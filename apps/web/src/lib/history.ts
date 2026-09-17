import type { ResultRow } from "./flatten";

/**
 * The subject over time.
 *
 * A true "as known then" replay needs stored historical snapshots, which Scout
 * does not keep. What it does have is the dates the sources themselves carry —
 * when a contribution was filed, a certificate issued, a domain registered, a
 * threat first seen. Ordering those is an honest history of what is on record
 * about the subject, built from the same results already shown.
 *
 * A row with no date is simply not in the timeline; it is not invented onto one.
 */

export interface HistoryEntry {
  date: string;
  /** Group heading of the result, e.g. "Registration", "Certificates". */
  type: string;
  value: string;
  detail: string;
  sources: string[];
}

/** Date-bearing fields seen across the observation shapes, in preference order. */
const DATE_FIELDS = [
  "date",
  "created",
  "notBefore",
  "firstSeen",
  "observedAt",
  "registered",
  "certIssued",
  "lastSeen",
  "updated",
];

/** First plausible ISO-ish date on an observation, or null. */
export function dateOf(observation: unknown): string | null {
  if (typeof observation !== "object" || observation === null) return null;
  const o = observation as Record<string, unknown>;
  for (const field of DATE_FIELDS) {
    const raw = o[field];
    if (typeof raw !== "string" || raw === "") continue;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) continue;
    const year = new Date(t).getUTCFullYear();
    if (year < 1900 || year > 2100) continue;
    return new Date(t).toISOString();
  }
  return null;
}

/**
 * One entry per result that carries a date, oldest first. A result with several
 * dated observations uses its earliest — the first time the subject shows up in
 * that record.
 */
export function buildHistory(rows: ResultRow[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const row of rows) {
    let earliest: string | null = null;
    for (const item of row.evidence) {
      const date = dateOf(item.observation);
      if (date === null) continue;
      if (earliest === null || date < earliest) earliest = date;
    }
    if (earliest === null) continue;
    entries.push({
      date: earliest,
      type: row.type,
      value: row.value,
      detail: row.detail,
      sources: row.sources,
    });
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date));
}

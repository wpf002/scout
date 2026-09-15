import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const virusTotalSource = requireSource("virustotal");

/**
 * VirusTotal — one lookup that answers for four subject kinds.
 *
 * It aggregates 70-odd engines plus its own crawl, and it is the closest thing
 * the field has to a default: a hash, a domain, an address or a URL all have an
 * entry, and the entry carries both the verdicts and the pivots (contacted
 * domains, resolutions, sibling samples).
 *
 * Two things shape the code. The free tier allows four requests a minute, so
 * this makes exactly one call per subject and never fans out across the
 * relationship endpoints. And a 404 means "nothing submitted", which is not the
 * same as "clean" — an unsubmitted file has never been looked at by anyone, and
 * reporting that as a negative verdict would be the most dangerous thing this
 * adapter could do.
 */

const BASE = "https://www.virustotal.com/api/v3";
const TIMEOUT_MS = 20_000;

interface AnalysisStats {
  malicious?: number;
  suspicious?: number;
  harmless?: number;
  undetected?: number;
}

/** Which endpoint answers for this subject. */
function pathFor(subject: Subject): string | null {
  switch (subject.kind) {
    case "hash":
      return `files/${encodeURIComponent(subject.value.trim().toLowerCase())}`;
    case "domain":
      return `domains/${encodeURIComponent(subject.value.trim().toLowerCase())}`;
    case "ip":
      return `ip_addresses/${encodeURIComponent(subject.value.trim())}`;
    default:
      return null;
  }
}

function count(stats: AnalysisStats): { flagged: number; total: number } {
  const malicious = stats.malicious ?? 0;
  const suspicious = stats.suspicious ?? 0;
  const total = malicious + suspicious + (stats.harmless ?? 0) + (stats.undetected ?? 0);
  return { flagged: malicious + suspicious, total };
}

function iso(seconds: unknown): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

export function normalizeVirusTotal(raw: unknown, subject: Subject): InfraObservation[] {
  const attributes = (raw as { data?: { attributes?: unknown } }).data?.attributes;
  if (typeof attributes !== "object" || attributes === null) return [];
  const a = attributes as Record<string, unknown>;

  const stats = (a["last_analysis_stats"] ?? {}) as AnalysisStats;
  const { flagged, total } = count(stats);
  const out: InfraObservation[] = [];

  const tags = [
    ...(Array.isArray(a["tags"]) ? (a["tags"] as unknown[]).filter((t): t is string => typeof t === "string") : []),
    ...(typeof a["type_description"] === "string" ? [a["type_description"] as string] : []),
  ];

  // The verdict, as a count rather than a label. "38 of 72 engines" is a fact;
  // "malicious" is a summary that hides how thin the agreement might be.
  if (total > 0) {
    out.push({
      kind: "reputation",
      ip: subject.value,
      verdict: flagged > 0 ? `${flagged} of ${total} engines flagged this` : `Clean across ${total} engines`,
      actor: typeof a["meaningful_name"] === "string" ? (a["meaningful_name"] as string) : null,
      // VirusTotal does not classify background noise; claiming it does would
      // put words in the service's mouth.
      noise: false,
      benign: flagged === 0,
      lastSeen: iso(a["last_analysis_date"]) ?? iso(a["last_modification_date"]) ?? null,
      reportUrl: `https://www.virustotal.com/gui/search/${encodeURIComponent(subject.value)}`,
    });
  }

  // For a file, what it is matters as much as whether it is flagged.
  if (subject.kind === "hash") {
    const names = Array.isArray(a["names"])
      ? (a["names"] as unknown[]).filter((n): n is string => typeof n === "string")
      : [];
    const size = typeof a["size"] === "number" ? a["size"] : null;

    out.push({
      kind: "threat-pulse",
      name:
        typeof a["meaningful_name"] === "string"
          ? (a["meaningful_name"] as string)
          : (names[0] ?? "Submitted file"),
      author: null,
      created: iso(a["first_submission_date"]),
      tags: [
        ...tags,
        ...(size === null ? [] : [`${size} bytes`]),
        ...(names.length > 1 ? [`${names.length} filenames`] : []),
      ].slice(0, 12),
      reportUrl: `https://www.virustotal.com/gui/file/${encodeURIComponent(subject.value)}`,
    });
  }

  // Resolutions are the pivot an investigator actually wants off a domain.
  if (subject.kind === "domain" || subject.kind === "ip") {
    const records = Array.isArray(a["last_dns_records"]) ? (a["last_dns_records"] as unknown[]) : [];
    for (const record of records.slice(0, 40)) {
      if (typeof record !== "object" || record === null) continue;
      const r = record as Record<string, unknown>;
      if (typeof r["type"] !== "string" || typeof r["value"] !== "string") continue;
      out.push({
        kind: "dns-record",
        name: subject.value,
        type: r["type"],
        value: r["value"],
      });
    }
  }

  return out;
}

export async function fetchVirusTotal(subject: Subject): Promise<InfraObservation[]> {
  const path = pathFor(subject);
  if (path === null) return [];

  const key = process.env["VIRUSTOTAL_API_KEY"]?.trim();
  if (key === undefined || key === "") throw new Error("VIRUSTOTAL_API_KEY is not set");

  const response = await fetch(`${BASE}/${path}`, {
    headers: { accept: "application/json", "x-apikey": key },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // Nothing has ever been submitted. That is not a clean verdict and must not
  // be reported as one — returning no observations says "we learned nothing",
  // which is the truth.
  if (response.status === 404) return [];
  if (response.status === 401) throw new Error("VirusTotal rejected the API key.");
  if (response.status === 429) {
    throw new Error("VirusTotal rate limit reached — the free tier allows four requests a minute.");
  }
  if (!response.ok) throw new Error(`VirusTotal responded ${response.status}`);

  return normalizeVirusTotal(await response.json(), subject);
}

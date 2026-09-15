import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";
import { TtlCache } from "../../lib/cache.js";

export const threatFoxSource = requireSource("threatfox");

/**
 * ThreatFox — malware IOCs, looked up by hash.
 *
 * Hash was Scout's thinnest subject kind: Intelligence X was the only source
 * that would take one, so a hash either hit that index or the tool had nothing
 * to say about it.
 *
 * This reads abuse.ch's public recent export rather than their query API. The
 * API moved behind an Auth-Key in 2024 — `threatfox-api.abuse.ch` answers 401
 * to an anonymous caller — while the bulk export stayed open. The export is a
 * few thousand IOCs covering roughly the last few days, so a miss here means
 * "not in the recent window", not "not malicious", and the adapter says so
 * rather than returning a confident nothing.
 */
const EXPORT_URL = "https://threatfox.abuse.ch/export/json/recent/";
const TIMEOUT_MS = 25_000;

interface FoxEntry {
  ioc_value: string;
  ioc_type: string;
  threat_type: string | null;
  malware_printable: string | null;
  malware: string | null;
  first_seen_utc: string | null;
  last_seen_utc: string | null;
  confidence_level: number | null;
  tags: string | null;
  reporter: string | null;
}

/**
 * One fetch serves every lookup in the window. The export is a few megabytes
 * and identical for every caller, so pulling it per query would be both slow
 * and rude to abuse.ch.
 */
const exportCache = new TtlCache<Map<string, FoxEntry[]>>({
  ttlMs: 30 * 60 * 1000,
  maxEntries: 1,
});

/** Hash IOC types in the export, so non-hash rows are not indexed. */
const HASH_TYPES = new Set(["md5_hash", "sha1_hash", "sha256_hash"]);

export function indexByHash(raw: unknown): Map<string, FoxEntry[]> {
  const index = new Map<string, FoxEntry[]>();
  if (typeof raw !== "object" || raw === null) return index;

  for (const group of Object.values(raw as Record<string, unknown>)) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Partial<FoxEntry>;
      if (typeof entry.ioc_value !== "string" || typeof entry.ioc_type !== "string") continue;
      if (!HASH_TYPES.has(entry.ioc_type)) continue;

      const key = entry.ioc_value.trim().toLowerCase();
      const list = index.get(key) ?? [];
      list.push(entry as FoxEntry);
      index.set(key, list);
    }
  }
  return index;
}

async function loadIndex(): Promise<Map<string, FoxEntry[]>> {
  const cached = exportCache.get("recent");
  if (cached !== undefined) return cached;

  const response = await fetch(EXPORT_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ThreatFox export responded ${response.status}`);

  const index = indexByHash(await response.json());
  exportCache.set("recent", index);
  return index;
}

export function toObservations(entries: FoxEntry[]): InfraObservation[] {
  return entries.map((entry) => ({
    kind: "threat-pulse" as const,
    name: entry.malware_printable ?? entry.malware ?? entry.threat_type ?? "Malware IOC",
    author: entry.reporter ?? null,
    created: entry.first_seen_utc ?? null,
    tags: [
      ...(entry.threat_type === null ? [] : [entry.threat_type]),
      ...(entry.tags === null || entry.tags === "" ? [] : entry.tags.split(",").map((t) => t.trim())),
      ...(entry.confidence_level === null ? [] : [`confidence ${entry.confidence_level}%`]),
    ].filter((tag) => tag !== ""),
    reportUrl: `https://threatfox.abuse.ch/browse.php?search=ioc%3A${encodeURIComponent(entry.ioc_value)}`,
  }));
}

export async function fetchThreatFox(subject: Subject): Promise<InfraObservation[]> {
  if (subject.kind !== "hash") return [];
  const index = await loadIndex();
  return toObservations(index.get(subject.value.trim().toLowerCase()) ?? []);
}

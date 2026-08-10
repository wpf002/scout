import { z } from "zod";
import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const waybackSource = requireSource("wayback-machine");

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The Wayback Machine's CDX index.
 *
 * This was a deeplink, which meant the answer to "what does the archive know
 * about this domain?" was a blank embedded frame — archive.org refuses to be
 * iframed, so the panel showed nothing at all. Reading the CDX API server-side
 * turns that into rows: which hosts and paths were archived, and the window
 * they were captured over.
 *
 * `collapse=urlkey` asks the archive to return one row per unique URL rather
 * than one per capture. A busy domain has hundreds of thousands of captures,
 * and without this the response is enormous and says the same thing.
 */
const cdxSchema = z.array(z.array(z.string()));

/** Cap on distinct URLs pulled back. The archive is effectively unbounded. */
const LIMIT = 2000;

export function normalizeWayback(
  rows: string[][],
  domain: string,
): InfraObservation[] {
  // The first row is the header. An empty archive returns nothing at all.
  if (rows.length <= 1) return [];

  const header = rows[0] ?? [];
  const originalIndex = header.indexOf("original");
  const timestampIndex = header.indexOf("timestamp");
  if (originalIndex === -1) return [];

  const apex = domain.trim().toLowerCase();
  const hosts = new Map<string, { first: string | null; last: string | null }>();

  for (const row of rows.slice(1)) {
    const original = row[originalIndex];
    if (original === undefined) continue;

    let hostname: string;
    try {
      hostname = new URL(
        original.startsWith("http") ? original : `http://${original}`,
      ).hostname.toLowerCase();
    } catch {
      continue;
    }

    if (hostname !== apex && !hostname.endsWith(`.${apex}`)) continue;

    // CDX timestamps are YYYYMMDDhhmmss. Rendered as a date, the rest is noise.
    const raw = timestampIndex === -1 ? undefined : row[timestampIndex];
    const stamp =
      raw !== undefined && raw.length >= 8
        ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
        : null;

    const existing = hosts.get(hostname);
    if (existing === undefined) {
      hosts.set(hostname, { first: stamp, last: stamp });
      continue;
    }
    if (stamp !== null) {
      if (existing.first === null || stamp < existing.first) {
        existing.first = stamp;
      }
      if (existing.last === null || stamp > existing.last) {
        existing.last = stamp;
      }
    }
  }

  return [...hosts.entries()].map(([hostname, seen]) => ({
    kind: "subdomain" as const,
    hostname,
    firstSeen: seen.first,
    lastSeen: seen.last,
  }));
}

export async function fetchWayback(
  subject: Subject,
): Promise<InfraObservation[]> {
  const domain = subject.value.trim().toLowerCase();
  const url =
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}` +
    `&matchType=domain&output=json&fl=original,timestamp&collapse=urlkey&limit=${LIMIT}`;

  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Wayback Machine responded ${response.status}`);
  }

  const text = await response.text();
  if (text.trim().length === 0) return [];

  return normalizeWayback(cdxSchema.parse(JSON.parse(text)), domain);
}

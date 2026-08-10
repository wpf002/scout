import { z } from "zod";
import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const urlscanSource = requireSource("urlscan");

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * urlscan.io search, not submission.
 *
 * Only the search API is used — Scout reads scans other people have already
 * run. Submitting a scan is a different act: it fetches the target from
 * urlscan's infrastructure, and by default publishes the result, which means
 * an investigation would announce itself both to the target and to everyone
 * watching the public feed. Reading is passive; scanning is not, and that is
 * not a decision to make silently inside a batch run.
 */
const searchSchema = z.object({
  results: z
    .array(
      z.object({
        page: z
          .object({
            domain: z.string().nullable().default(null),
            ip: z.string().nullable().default(null),
            asn: z.string().nullable().default(null),
            asnname: z.string().nullable().default(null),
            country: z.string().nullable().default(null),
            server: z.string().nullable().default(null),
          })
          .default({}),
        task: z
          .object({
            time: z.string().nullable().default(null),
            url: z.string().nullable().default(null),
          })
          .default({}),
      }),
    )
    .default([]),
});

export type UrlscanSearch = z.infer<typeof searchSchema>;

/**
 * Turns scan records into hosts and subdomains.
 *
 * Exported for tests. urlscan returns one record per scan, so a busy domain
 * yields the same host dozens of times; the dedupe here keeps the adapter from
 * handing the consolidation layer avoidable duplicates.
 */
export function normalizeUrlscan(
  payload: UrlscanSearch,
  domain: string,
): InfraObservation[] {
  const apex = domain.trim().toLowerCase();
  const observations: InfraObservation[] = [];
  const seenHosts = new Set<string>();
  const seenIps = new Set<string>();

  for (const record of payload.results) {
    const hostname = record.page.domain?.trim().toLowerCase() ?? "";

    // A scan of an unrelated page can reference this domain without being it.
    // Attributing that host to this subject would be wrong.
    if (
      hostname.length > 0 &&
      (hostname === apex || hostname.endsWith(`.${apex}`)) &&
      !seenHosts.has(hostname)
    ) {
      seenHosts.add(hostname);
      observations.push({
        kind: "subdomain",
        hostname,
        firstSeen: null,
        lastSeen: record.task.time,
      });
    }

    const ip = record.page.ip?.trim() ?? "";
    if (ip.length > 0 && !seenIps.has(ip)) {
      seenIps.add(ip);
      observations.push({
        kind: "host",
        ip,
        hostnames: hostname.length > 0 ? [hostname] : [],
        ports: [],
        org: record.page.asnname,
        asn: record.page.asn,
        country: record.page.country,
        lastSeen: record.task.time,
      });
    }
  }

  return observations;
}

export async function fetchUrlscan(
  subject: Subject,
): Promise<InfraObservation[]> {
  const domain = subject.value.trim().toLowerCase();
  const query = subject.kind === "ip" ? `ip:"${domain}"` : `domain:"${domain}"`;
  const url = `https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=100`;

  const key = process.env[urlscanSource.keyEnv ?? ""] ?? "";
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      // The search API works unauthenticated at a lower rate limit, but the
      // key is required by the registry so a run is never silently throttled.
      "api-key": key,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`urlscan.io responded ${response.status}`);
  }

  return normalizeUrlscan(searchSchema.parse(await response.json()), domain);
}

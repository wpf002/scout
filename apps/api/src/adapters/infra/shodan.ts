import { z } from "zod";
import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";
import { resolveAddresses } from "./resolve.js";

export const shodanSource = requireSource("shodan");

const REQUEST_TIMEOUT_MS = 15_000;

/** `/dns/domain/{domain}` — subdomains and DNS records. */
const domainSchema = z.object({
  domain: z.string(),
  subdomains: z.array(z.string()).default([]),
  data: z
    .array(
      z.object({
        subdomain: z.string().default(""),
        type: z.string().default(""),
        value: z.string().default(""),
        last_seen: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

/** `/shodan/host/{ip}` — ports, banners and network metadata. */
const hostSchema = z.object({
  ip_str: z.string(),
  hostnames: z.array(z.string()).default([]),
  ports: z.array(z.number().int()).default([]),
  org: z.string().nullable().default(null),
  asn: z.string().nullable().default(null),
  country_name: z.string().nullable().default(null),
  last_update: z.string().nullable().default(null),
});

export type ShodanDomain = z.infer<typeof domainSchema>;
export type ShodanHost = z.infer<typeof hostSchema>;

export function normalizeShodanDomain(
  payload: ShodanDomain,
): InfraObservation[] {
  const apex = payload.domain.trim().toLowerCase();
  const observations: InfraObservation[] = [];
  const seen = new Set<string>();

  const addSubdomain = (hostname: string, lastSeen: string | null) => {
    const normalized = hostname.trim().toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) return;
    seen.add(normalized);
    observations.push({
      kind: "subdomain",
      hostname: normalized,
      firstSeen: null,
      lastSeen,
    });
  };

  for (const sub of payload.subdomains) {
    addSubdomain(sub === "" ? apex : `${sub}.${apex}`, null);
  }

  for (const record of payload.data) {
    const hostname =
      record.subdomain === "" ? apex : `${record.subdomain}.${apex}`;
    addSubdomain(hostname, record.last_seen);

    // An A/AAAA record is a host sighting too, and Shodan gives it for free.
    if (record.type === "A" || record.type === "AAAA") {
      observations.push({
        kind: "host",
        ip: record.value,
        hostnames: [hostname],
        ports: [],
        org: null,
        asn: null,
        country: null,
        lastSeen: record.last_seen,
      });
    }
  }

  return observations;
}

export function normalizeShodanHost(payload: ShodanHost): InfraObservation[] {
  return [
    {
      kind: "host",
      ip: payload.ip_str,
      hostnames: payload.hostnames.map((h) => h.trim().toLowerCase()).sort(),
      // Ports stay integers — counted things are never floats.
      ports: [...new Set(payload.ports)].sort((a, b) => a - b),
      org: payload.org,
      asn: payload.asn,
      country: payload.country_name,
      lastSeen: payload.last_update,
    },
  ];
}

/**
 * Shodan, with a free fallback.
 *
 * `/dns/domain` and `/shodan/host` both require a paid membership — a free
 * account's key is valid and returns "Requires membership or higher" for
 * every call, which is indistinguishable from a broken key unless the message
 * is shown.
 *
 * InternetDB is Shodan's free, keyless view of the same scan data: open ports,
 * hostnames, detected software and known CVEs for an address. It is not as
 * rich as the paid endpoints, but it is the difference between this source
 * contributing and being permanently dead on an unpaid account. The paid path
 * is still tried first, so a membership upgrades the results with no config
 * change.
 */
const INTERNETDB = "https://internetdb.shodan.io";

/** Free-path lookups fan out per address, so a domain is capped. */
const MAX_ADDRESSES = 3;

const internetDbSchema = z.object({
  ip: z.string(),
  hostnames: z.array(z.string()).default([]),
  ports: z.array(z.number().int()).default([]),
  cpes: z.array(z.string()).default([]),
  vulns: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export type InternetDbHost = z.infer<typeof internetDbSchema>;

export function normalizeInternetDb(host: InternetDbHost): InfraObservation[] {
  return [
    {
      kind: "host",
      ip: host.ip,
      hostnames: host.hostnames,
      ports: [...new Set(host.ports)].sort((a, b) => a - b),
      // InternetDB carries no ownership data, so these stay null rather than
      // being filled with something adjacent. A guessed org is worse than none.
      org: null,
      asn: null,
      country: null,
      lastSeen: null,
      // The whole reason the free endpoint is worth calling. A CVE list is the
      // most actionable thing an infrastructure scan produces, and it was
      // being parsed and then thrown away.
      vulns: host.vulns,
      software: host.cpes.map((cpe) => cpe.replace(/^cpe:\/[aoh]:/, "")),
      tags: host.tags,
    },
  ];
}

async function fetchInternetDb(
  subject: Subject,
): Promise<InfraObservation[]> {
  const value = subject.value.trim().toLowerCase();
  const addresses =
    subject.kind === "ip" ? [value] : await resolveAddresses(value, MAX_ADDRESSES);

  const observations: InfraObservation[] = [];
  for (const address of addresses) {
    const response = await fetch(
      `${INTERNETDB}/${encodeURIComponent(address)}`,
      {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    // 404 means Shodan has never scanned it — a real answer.
    if (response.status === 404) continue;
    if (!response.ok) continue;

    observations.push(
      ...normalizeInternetDb(internetDbSchema.parse(await response.json())),
    );
  }

  return observations;
}

export async function fetchShodan(
  subject: Subject,
): Promise<InfraObservation[]> {
  const key = process.env["SHODAN_API_KEY"]?.trim();
  if (key === undefined || key.length === 0) {
    throw new Error("SHODAN_API_KEY is not configured");
  }

  const value = subject.value.trim().toLowerCase();
  const path =
    subject.kind === "ip"
      ? `/shodan/host/${encodeURIComponent(value)}`
      : `/dns/domain/${encodeURIComponent(value)}`;

  const response = await fetch(
    `https://api.shodan.io${path}?key=${encodeURIComponent(key)}`,
    {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  // 401/403 is the unpaid-account signature. Fall back rather than fail: the
  // free view still answers the question, just with less detail.
  if (response.status === 401 || response.status === 403) {
    const fallback = await fetchInternetDb(subject);
    if (fallback.length > 0) return fallback;
    throw new Error(
      "Shodan requires a paid membership for this endpoint, and its free " +
        "InternetDB view has no record of this target.",
    );
  }

  if (response.status === 404) return [];
  if (!response.ok) {
    // The key is in the query string, so the URL is never put in the message.
    throw new Error(`Shodan responded ${response.status}`);
  }

  const payload = await response.json();
  return subject.kind === "ip"
    ? normalizeShodanHost(hostSchema.parse(payload))
    : normalizeShodanDomain(domainSchema.parse(payload));
}

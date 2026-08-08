import { z } from "zod";
import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

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

  // 404 means Shodan has nothing on this target — a real negative answer.
  if (response.status === 404) return [];
  // Status only. The key is in the query string, so the URL must never appear
  // in an error message that ends up in the audit log.
  if (!response.ok) throw new Error(`Shodan responded ${response.status}`);

  const body: unknown = await response.json();
  return subject.kind === "ip"
    ? normalizeShodanHost(hostSchema.parse(body))
    : normalizeShodanDomain(domainSchema.parse(body));
}

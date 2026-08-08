import { z } from "zod";
import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const securityTrailsSource = requireSource("securitytrails");

const REQUEST_TIMEOUT_MS = 15_000;

/** `/v1/domain/{domain}/subdomains` — labels only, not full hostnames. */
const subdomainsSchema = z.object({
  subdomains: z.array(z.string()).default([]),
});

/** `/v1/ips/nearby/{ip}` style payload, trimmed to what we normalize. */
const ipSchema = z.object({
  blocks: z
    .array(
      z.object({
        ip: z.string(),
        hostname: z.string().nullable().default(null),
        organization: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

export type SecurityTrailsSubdomains = z.infer<typeof subdomainsSchema>;
export type SecurityTrailsIps = z.infer<typeof ipSchema>;

/**
 * SecurityTrails returns bare labels (`www`, `mail.staging`), not hostnames.
 * Joining them onto the apex here is what lets its output dedupe against
 * crt.sh, which returns fully-qualified names.
 */
export function normalizeSecurityTrailsSubdomains(
  payload: SecurityTrailsSubdomains,
  apex: string,
): InfraObservation[] {
  const domain = apex.trim().toLowerCase();
  return [
    ...new Set(
      payload.subdomains
        .map((label) => label.trim().toLowerCase())
        .filter((label) => label.length > 0)
        .map((label) => `${label}.${domain}`),
    ),
  ]
    .sort()
    .map((hostname) => ({
      kind: "subdomain" as const,
      hostname,
      firstSeen: null,
      lastSeen: null,
    }));
}

export function normalizeSecurityTrailsIps(
  payload: SecurityTrailsIps,
): InfraObservation[] {
  return payload.blocks.map((block) => ({
    kind: "host" as const,
    ip: block.ip,
    hostnames:
      block.hostname === null ? [] : [block.hostname.trim().toLowerCase()],
    ports: [],
    org: block.organization,
    asn: null,
    country: null,
    lastSeen: null,
  }));
}

export async function fetchSecurityTrails(
  subject: Subject,
): Promise<InfraObservation[]> {
  const key = process.env["SECURITYTRAILS_API_KEY"]?.trim();
  if (key === undefined || key.length === 0) {
    throw new Error("SECURITYTRAILS_API_KEY is not configured");
  }

  const value = subject.value.trim().toLowerCase();
  const path =
    subject.kind === "ip"
      ? `/v1/ips/nearby/${encodeURIComponent(value)}`
      : `/v1/domain/${encodeURIComponent(value)}/subdomains?children_only=false`;

  const response = await fetch(`https://api.securitytrails.com${path}`, {
    // The key goes in a header, not the URL — nothing to leak into a log line.
    headers: { apikey: key, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`SecurityTrails responded ${response.status}`);
  }

  const body: unknown = await response.json();
  return subject.kind === "ip"
    ? normalizeSecurityTrailsIps(ipSchema.parse(body))
    : normalizeSecurityTrailsSubdomains(subdomainsSchema.parse(body), value);
}

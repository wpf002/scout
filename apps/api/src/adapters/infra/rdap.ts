import { z } from "zod";
import { Resolver } from "node:dns/promises";
import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const rdapSource = requireSource("rdap");

const REQUEST_TIMEOUT_MS = 20_000;

/** DNS queries are fast or broken; a long wait here only delays the run. */
const DNS_TIMEOUT_MS = 5_000;

/**
 * Registration and live DNS — the two things every domain investigation starts
 * with, and the only sources here that need no account of any kind.
 *
 * RDAP is the structured replacement for WHOIS: JSON rather than free text, so
 * registrar and dates come back as fields instead of something to regex out of
 * a paragraph. `rdap.org` bootstraps to the right registry for the TLD, which
 * saves maintaining that mapping.
 *
 * The DNS half resolves against public resolvers rather than the host's
 * configured ones. An investigator on a corporate or VPN network otherwise
 * gets that network's split-horizon answers, which are not what the internet
 * sees — and quietly recording internal answers as public findings would be
 * worse than returning nothing.
 */
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

const rdapSchema = z.object({
  ldhName: z.string().optional(),
  status: z.array(z.string()).default([]),
  events: z
    .array(
      z.object({
        eventAction: z.string().optional(),
        eventDate: z.string().optional(),
      }),
    )
    .default([]),
  nameservers: z
    .array(z.object({ ldhName: z.string().optional() }))
    .default([]),
  entities: z
    .array(
      z.object({
        roles: z.array(z.string()).default([]),
        vcardArray: z.array(z.unknown()).optional(),
      }),
    )
    .default([]),
});

export type RdapDomain = z.infer<typeof rdapSchema>;

/** Pulls the display name out of a jCard, which is a nested array format. */
function vcardName(vcardArray: unknown[] | undefined): string | null {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return null;
  const entries = vcardArray[1];
  if (!Array.isArray(entries)) return null;

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 4) continue;
    if (entry[0] === "fn" && typeof entry[3] === "string") return entry[3];
  }
  return null;
}

function eventDate(payload: RdapDomain, action: string): string | null {
  const event = payload.events.find((e) => e.eventAction === action);
  return event?.eventDate ?? null;
}

export function normalizeRdap(
  payload: RdapDomain,
  domain: string,
): InfraObservation[] {
  const registrar = payload.entities.find((entity) =>
    entity.roles.includes("registrar"),
  );

  return [
    {
      kind: "registration",
      domain: (payload.ldhName ?? domain).toLowerCase(),
      registrar: vcardName(registrar?.vcardArray),
      created: eventDate(payload, "registration"),
      updated: eventDate(payload, "last changed"),
      expires: eventDate(payload, "expiration"),
      nameservers: payload.nameservers
        .map((ns) => ns.ldhName?.toLowerCase())
        .filter((ns): ns is string => ns !== undefined),
      statuses: payload.status,
    },
  ];
}

async function fetchRegistration(domain: string): Promise<InfraObservation[]> {
  const response = await fetch(
    `https://rdap.org/domain/${encodeURIComponent(domain)}`,
    {
      headers: { accept: "application/rdap+json, application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  // An unregistered domain is a 404, and that is a real answer rather than a
  // failure — it just has no registration to report.
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`RDAP responded ${response.status}`);

  return normalizeRdap(rdapSchema.parse(await response.json()), domain);
}

async function fetchDns(domain: string): Promise<InfraObservation[]> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  resolver.setServers(PUBLIC_RESOLVERS);

  const observations: InfraObservation[] = [];
  const record = (type: string, value: string) =>
    observations.push({ kind: "dns-record", name: domain, type, value });

  // Every lookup is independent, and a domain with no MX is normal rather than
  // an error — so each failure is swallowed on its own instead of taking the
  // others down with it.
  const settled = await Promise.allSettled([
    resolver.resolve4(domain).then((ips) => ips.forEach((ip) => record("A", ip))),
    resolver
      .resolve6(domain)
      .then((ips) => ips.forEach((ip) => record("AAAA", ip))),
    resolver
      .resolveNs(domain)
      .then((hosts) => hosts.forEach((h) => record("NS", h.toLowerCase()))),
    resolver
      .resolveMx(domain)
      .then((rows) =>
        rows.forEach((r) => record("MX", `${r.priority} ${r.exchange}`)),
      ),
    resolver
      .resolveTxt(domain)
      .then((rows) => rows.forEach((r) => record("TXT", r.join("")))),
  ]);

  // If every single lookup failed, the domain did not resolve at all. Saying
  // so beats reporting an empty DNS section that looks like a domain with no
  // records.
  if (settled.every((result) => result.status === "rejected")) {
    throw new Error(`${domain} did not resolve.`);
  }

  return observations;
}

export async function fetchRdap(
  subject: Subject,
): Promise<InfraObservation[]> {
  const domain = subject.value.trim().toLowerCase();

  const [registration, dns] = await Promise.allSettled([
    fetchRegistration(domain),
    fetchDns(domain),
  ]);

  const observations: InfraObservation[] = [];
  if (registration.status === "fulfilled") observations.push(...registration.value);
  if (dns.status === "fulfilled") observations.push(...dns.value);

  // Both halves failing is a genuine failure; one failing still leaves a
  // useful answer, so it is not allowed to sink the other.
  if (observations.length === 0) {
    const reason =
      registration.status === "rejected"
        ? registration.reason
        : dns.status === "rejected"
          ? dns.reason
          : null;
    throw new Error(
      reason instanceof Error ? reason.message : "No registration or DNS data.",
    );
  }

  return observations;
}

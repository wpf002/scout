import { z } from "zod";
import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

/**
 * The keyless infrastructure sources.
 *
 * Grouped in one file because they share a shape: no key, no account, no
 * signup — a plain HTTP GET and a parse. That property is the reason they
 * exist here at all. The commercial sources this tool was originally built
 * around have moved upmarket far enough that a single one now asks $500 a
 * month, which for an unfunded investigation is the same as not existing. What
 * follows covers most of the same ground for nothing.
 *
 * Every one of them is rate limited by IP rather than by key, so they are
 * polite by construction: one request each, no retry storms, short timeouts.
 */

const REQUEST_TIMEOUT_MS = 20_000;

/** Shared by all of these — they are anonymous, so identify honestly. */
const UA = "Scout-OSINT/0.1 (+authorized-engagement-tooling)";

/** True when `hostname` is the domain itself or beneath it. */
function within(hostname: string, apex: string): boolean {
  return hostname === apex || hostname.endsWith(`.${apex}`);
}

// ── HackerTarget ───────────────────────────────────────────────────────────

export const hackerTargetSource = requireSource("hackertarget");

/**
 * `hostsearch` returns `hostname,ip` per line as plain text.
 *
 * Errors arrive as prose with a 200 — "API count exceeded", "error invalid
 * input" — so a body that does not parse as host rows is treated as a failure
 * rather than as an empty result. Silently returning nothing here would read
 * as "this domain has no hosts".
 */
export function parseHackerTarget(
  body: string,
  apex: string,
): InfraObservation[] {
  const observations: InfraObservation[] = [];
  const seen = new Set<string>();

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const [rawHost, rawIp] = trimmed.split(",");
    const hostname = rawHost?.trim().toLowerCase();
    if (hostname === undefined || !within(hostname, apex)) continue;

    if (!seen.has(hostname)) {
      seen.add(hostname);
      observations.push({
        kind: "subdomain",
        hostname,
        firstSeen: null,
        lastSeen: null,
      });
    }

    const ip = rawIp?.trim();
    if (ip !== undefined && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      observations.push({
        kind: "host",
        ip,
        hostnames: [hostname],
        ports: [],
        org: null,
        asn: null,
        country: null,
        lastSeen: null,
      });
    }
  }

  return observations;
}

export async function fetchHackerTarget(
  subject: Subject,
): Promise<InfraObservation[]> {
  const apex = subject.value.trim().toLowerCase();
  const response = await fetch(
    `https://api.hackertarget.com/hostsearch/?q=${encodeURIComponent(apex)}`,
    { headers: { "user-agent": UA }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );

  if (!response.ok) {
    throw new Error(`HackerTarget responded ${response.status}`);
  }

  const body = await response.text();
  if (/API count exceeded|error|invalid/i.test(body.slice(0, 120))) {
    throw new Error(`HackerTarget: ${body.trim().slice(0, 120)}`);
  }

  return parseHackerTarget(body, apex);
}

// ── CertSpotter ────────────────────────────────────────────────────────────

export const certSpotterSource = requireSource("certspotter");

const certSpotterSchema = z.array(
  z.object({
    dns_names: z.array(z.string()).default([]),
    not_before: z.string().nullable().default(null),
    not_after: z.string().nullable().default(null),
    issuer: z
      .union([z.string(), z.object({ name: z.string().optional() })])
      .nullable()
      .default(null),
  }),
);

export type CertSpotterIssuances = z.infer<typeof certSpotterSchema>;

/**
 * Certificate Transparency, as a working alternative to crt.sh.
 *
 * crt.sh is the obvious CT source and has been returning 502s and 404s
 * throughout this work. CertSpotter indexes the same logs, answers reliably,
 * and needs no key — so a domain still gets its certificate history when
 * crt.sh is down, which is most of the time lately.
 */
export function normalizeCertSpotter(
  issuances: CertSpotterIssuances,
  apex: string,
): InfraObservation[] {
  const observations: InfraObservation[] = [];
  const seen = new Set<string>();

  for (const issuance of issuances) {
    const issuer =
      typeof issuance.issuer === "string"
        ? issuance.issuer
        : (issuance.issuer?.name ?? null);

    const names = issuance.dns_names
      .map((name) => name.trim().toLowerCase().replace(/^\*\./, ""))
      .filter((name) => within(name, apex));

    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      observations.push({
        kind: "subdomain",
        hostname: name,
        firstSeen: issuance.not_before,
        lastSeen: issuance.not_after,
      });
    }

    const commonName = names[0];
    if (commonName !== undefined) {
      observations.push({
        kind: "cert",
        serial: null,
        commonName,
        names,
        issuer,
        notBefore: issuance.not_before,
        notAfter: issuance.not_after,
      });
    }
  }

  return observations;
}

export async function fetchCertSpotter(
  subject: Subject,
): Promise<InfraObservation[]> {
  const apex = subject.value.trim().toLowerCase();
  const url =
    `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(apex)}` +
    `&include_subdomains=true&expand=dns_names&expand=issuer`;

  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // 429 is the anonymous rate limit, and it means "come back later" rather
  // than "there is nothing here".
  if (response.status === 429) {
    throw new Error("CertSpotter rate limit reached for this address.");
  }
  if (!response.ok) {
    throw new Error(`CertSpotter responded ${response.status}`);
  }

  return normalizeCertSpotter(
    certSpotterSchema.parse(await response.json()),
    apex,
  );
}

// ── RapidDNS ───────────────────────────────────────────────────────────────

export const rapidDnsSource = requireSource("rapiddns");

/**
 * RapidDNS publishes no API, so this reads hostnames out of the results table.
 *
 * A scrape is fragile by nature, which is why it extracts by pattern — every
 * hostname under the queried domain, anywhere in the document — rather than by
 * walking table rows. Markup changes constantly; the hostnames in it do not.
 */
export function parseRapidDns(html: string, apex: string): InfraObservation[] {
  const escaped = apex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`[a-z0-9][a-z0-9._-]*\\.${escaped}`, "gi");

  const seen = new Set<string>();
  const observations: InfraObservation[] = [];

  for (const match of html.matchAll(pattern)) {
    const hostname = match[0].toLowerCase();
    if (seen.has(hostname) || !within(hostname, apex)) continue;
    seen.add(hostname);
    observations.push({
      kind: "subdomain",
      hostname,
      firstSeen: null,
      lastSeen: null,
    });
  }

  return observations;
}

export async function fetchRapidDns(
  subject: Subject,
): Promise<InfraObservation[]> {
  const apex = subject.value.trim().toLowerCase();
  const response = await fetch(
    `https://rapiddns.io/subdomain/${encodeURIComponent(apex)}?full=1`,
    {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(`RapidDNS responded ${response.status}`);
  }

  return parseRapidDns(await response.text(), apex);
}

// ── AlienVault OTX ─────────────────────────────────────────────────────────

export const otxSource = requireSource("otx");

const otxSchema = z.object({
  passive_dns: z
    .array(
      z.object({
        hostname: z.string().default(""),
        address: z.string().default(""),
        first: z.string().nullable().default(null),
        last: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

export type OtxPassiveDns = z.infer<typeof otxSchema>;

export function normalizeOtx(
  payload: OtxPassiveDns,
  apex: string,
): InfraObservation[] {
  const observations: InfraObservation[] = [];
  const seenHosts = new Set<string>();
  const seenIps = new Set<string>();

  for (const record of payload.passive_dns) {
    const hostname = record.hostname.trim().toLowerCase();
    if (hostname.length > 0 && within(hostname, apex) && !seenHosts.has(hostname)) {
      seenHosts.add(hostname);
      observations.push({
        kind: "subdomain",
        hostname,
        firstSeen: record.first,
        lastSeen: record.last,
      });
    }

    const ip = record.address.trim();
    if (ip.length > 0 && !seenIps.has(ip)) {
      seenIps.add(ip);
      observations.push({
        kind: "host",
        ip,
        hostnames: hostname.length > 0 ? [hostname] : [],
        ports: [],
        org: null,
        asn: null,
        country: null,
        lastSeen: record.last,
      });
    }
  }

  return observations;
}

/**
 * OTX's `general` section, which carries the pulses an indicator appears in.
 *
 * A pulse is a named threat report by an author, with tags and a date. A
 * domain appearing in one is a materially different fact from a domain merely
 * resolving, and passive DNS alone never surfaces it — so this is a second
 * call rather than an optional extra.
 */
const otxGeneralSchema = z.object({
  pulse_info: z
    .object({
      count: z.number().int().default(0),
      pulses: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string().default(""),
            author_name: z.string().nullable().default(null),
            created: z.string().nullable().default(null),
            tags: z.array(z.string()).default([]),
          }),
        )
        .default([]),
    })
    .default({ count: 0, pulses: [] }),
});

export function normalizeOtxPulses(
  payload: z.infer<typeof otxGeneralSchema>,
): InfraObservation[] {
  return payload.pulse_info.pulses
    .filter((pulse) => pulse.name.trim().length > 0)
    .map((pulse) => ({
      kind: "threat-pulse" as const,
      name: pulse.name,
      author: pulse.author_name,
      created: pulse.created,
      tags: pulse.tags,
      reportUrl:
        pulse.id === undefined
          ? null
          : `https://otx.alienvault.com/pulse/${pulse.id}`,
    }));
}

export async function fetchOtx(
  subject: Subject,
): Promise<InfraObservation[]> {
  const apex = subject.value.trim().toLowerCase();
  const key = process.env["OTX_API_KEY"]?.trim() ?? "";
  const headers = {
    accept: "application/json",
    "user-agent": UA,
    ...(key.length > 0 ? { "X-OTX-API-KEY": key } : {}),
  };

  const base = `https://otx.alienvault.com/api/v1/indicators/domain/${encodeURIComponent(apex)}`;

  const [dns, general] = await Promise.allSettled([
    fetch(`${base}/passive_dns`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
    fetch(`${base}/general`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }),
  ]);

  const observations: InfraObservation[] = [];
  let failure: string | null = null;

  if (dns.status === "fulfilled" && dns.value.ok) {
    observations.push(
      ...normalizeOtx(otxSchema.parse(await dns.value.json()), apex),
    );
  } else if (dns.status === "fulfilled") {
    failure = `AlienVault OTX responded ${dns.value.status}`;
  }

  // Threat associations are worth having even when passive DNS is empty, and
  // vice versa — neither half is allowed to sink the other.
  if (general.status === "fulfilled" && general.value.ok) {
    observations.push(
      ...normalizeOtxPulses(otxGeneralSchema.parse(await general.value.json())),
    );
  }

  if (observations.length === 0 && failure !== null) throw new Error(failure);
  return observations;
}

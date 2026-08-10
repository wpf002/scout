import { z } from "zod";
import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";
import { resolveAddresses } from "./resolve.js";

export const censysSource = requireSource("censys");

const REQUEST_TIMEOUT_MS = 15_000;

/** Censys Platform search response, trimmed to the fields we normalize. */
const searchSchema = z.object({
  result: z
    .object({
      hits: z
        .array(
          z.object({
            ip: z.string().default(""),
            names: z.array(z.string()).default([]),
            autonomous_system: z
              .object({
                asn: z.number().int().nullable().default(null),
                name: z.string().nullable().default(null),
              })
              .nullable()
              .default(null),
            location: z
              .object({ country: z.string().nullable().default(null) })
              .nullable()
              .default(null),
            services: z
              .array(z.object({ port: z.number().int() }))
              .default([]),
            last_updated_at: z.string().nullable().default(null),
          }),
        )
        .default([]),
    })
    .default({ hits: [] }),
});

export type CensysSearch = z.infer<typeof searchSchema>;

export function normalizeCensys(payload: CensysSearch): InfraObservation[] {
  const observations: InfraObservation[] = [];

  for (const hit of payload.result.hits) {
    if (hit.ip.length === 0) continue;
    observations.push({
      kind: "host",
      ip: hit.ip,
      hostnames: [
        ...new Set(hit.names.map((n) => n.trim().toLowerCase())),
      ].sort(),
      ports: [...new Set(hit.services.map((s) => s.port))].sort((a, b) => a - b),
      org: hit.autonomous_system?.name ?? null,
      asn:
        hit.autonomous_system?.asn === null ||
        hit.autonomous_system?.asn === undefined
          ? null
          : `AS${hit.autonomous_system.asn}`,
      country: hit.location?.country ?? null,
      lastSeen: hit.last_updated_at,
    });
  }

  return observations;
}

/**
 * Censys, on the Platform API.
 *
 * The old implementation called `search.censys.io/api/v2` with a bearer token.
 * That endpoint wants HTTP Basic with an API ID and secret, so a Platform
 * personal access token got a 401 that read as a bad key — and Censys is
 * decommissioning legacy Search through 2026 regardless.
 *
 * Platform search is also out of reach on a free plan: it 403s with "requires
 * an organization ID for API access". Asset lookup by address is not, so that
 * is what this uses. A domain subject is resolved to its addresses first,
 * capped, because a free plan has 100 credits a month and one domain behind a
 * large CDN pool could spend the lot.
 */
const PLATFORM_BASE = "https://api.platform.censys.io/v3/global/asset/host";

/** Free plans are metered per lookup, so a domain fans out to a few at most. */
const MAX_ADDRESSES = 3;

const platformHostSchema = z.object({
  result: z.object({
    resource: z.object({
      ip: z.string(),
      location: z
        .object({
          country: z.string().nullable().default(null),
          city: z.string().nullable().default(null),
          province: z.string().nullable().default(null),
        })
        .partial()
        .optional(),
      autonomous_system: z
        .object({
          asn: z.number().int().nullable().default(null),
          name: z.string().nullable().default(null),
        })
        .partial()
        .optional(),
      dns: z
        .object({ names: z.array(z.string()).default([]) })
        .partial()
        .optional(),
      services: z
        .array(
          z.object({
            port: z.number().int().optional(),
            protocol: z.string().optional(),
            software: z
              .array(
                z.object({
                  vendor: z.string().optional(),
                  product: z.string().optional(),
                }),
              )
              .default([]),
            labels: z
              .array(z.object({ value: z.string().optional() }))
              .default([]),
          }),
        )
        .default([]),
    }),
  }),
});

export type CensysPlatformHost = z.infer<typeof platformHostSchema>;

export function normalizeCensysPlatform(
  payload: CensysPlatformHost,
): InfraObservation[] {
  const resource = payload.result.resource;
  const asn = resource.autonomous_system?.asn;

  return [
    {
      kind: "host",
      ip: resource.ip,
      hostnames: resource.dns?.names ?? [],
      ports: [
        ...new Set(
          resource.services
            .map((service) => service.port)
            .filter((port): port is number => typeof port === "number"),
        ),
      ].sort((a, b) => a - b),
      org: resource.autonomous_system?.name ?? null,
      asn: asn === null || asn === undefined ? null : `AS${asn}`,
      country: resource.location?.country ?? null,
      lastSeen: null,
      // Censys is the only source here that says what is actually listening,
      // rather than just that a port is open. `443/HTTPS` answers a question
      // `443` only raises.
      services: [
        ...new Set(
          resource.services
            .filter((service) => service.port !== undefined)
            .map((service) =>
              service.protocol === undefined
                ? String(service.port)
                : `${service.port}/${service.protocol}`,
            ),
        ),
      ].sort(),
      software: [
        ...new Set(
          resource.services.flatMap((service) =>
            service.software
              .map((entry) =>
                [entry.vendor, entry.product].filter(Boolean).join(" "),
              )
              .filter((name) => name.length > 0),
          ),
        ),
      ].sort(),
      // Labels are where Censys reports a WAF, a honeypot, a load balancer —
      // context that changes how a host should be read.
      tags: [
        ...new Set(
          resource.services.flatMap((service) =>
            service.labels
              .map((label) => label.value)
              .filter((value): value is string => value !== undefined),
          ),
        ),
      ].sort(),
      location:
        [resource.location?.city, resource.location?.province]
          .filter(Boolean)
          .join(", ") || null,
    },
  ];
}

export async function fetchCensys(
  subject: Subject,
): Promise<InfraObservation[]> {
  const key = process.env["CENSYS_API_KEY"]?.trim();
  if (key === undefined || key.length === 0) {
    throw new Error("CENSYS_API_KEY is not configured");
  }

  const value = subject.value.trim().toLowerCase();
  const addresses =
    subject.kind === "ip"
      ? [value]
      : await resolveAddresses(value, MAX_ADDRESSES);

  if (addresses.length === 0) return [];

  const observations: InfraObservation[] = [];
  let lastError: string | null = null;

  for (const address of addresses) {
    const response = await fetch(
      `${PLATFORM_BASE}/${encodeURIComponent(address)}`,
      {
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    // An address Censys has never scanned is a real answer, not a failure.
    if (response.status === 404) continue;
    if (!response.ok) {
      lastError = `Censys responded ${response.status}`;
      continue;
    }

    observations.push(
      ...normalizeCensysPlatform(platformHostSchema.parse(await response.json())),
    );
  }

  // Every address failing is a failure; some failing still leaves an answer.
  if (observations.length === 0 && lastError !== null) {
    throw new Error(lastError);
  }

  return observations;
}

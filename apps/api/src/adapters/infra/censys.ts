import { z } from "zod";
import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

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

export async function fetchCensys(
  subject: Subject,
): Promise<InfraObservation[]> {
  const key = process.env["CENSYS_API_KEY"]?.trim();
  if (key === undefined || key.length === 0) {
    throw new Error("CENSYS_API_KEY is not configured");
  }

  const value = subject.value.trim().toLowerCase();
  const query =
    subject.kind === "ip" ? `ip: "${value}"` : `names: "${value}"`;

  const response = await fetch(
    `https://search.censys.io/api/v2/hosts/search?q=${encodeURIComponent(query)}&per_page=50`,
    {
      headers: {
        // Key in a header, never in the URL.
        authorization: `Bearer ${key}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Censys responded ${response.status}`);

  return normalizeCensys(searchSchema.parse(await response.json()));
}

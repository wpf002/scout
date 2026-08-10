import { z } from "zod";
import type { DatasetObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const alephSource = requireSource("aleph");

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * OCCRP Aleph's public search API.
 *
 * Also promoted out of deeplink for the same reason as the Wayback Machine:
 * embedding it showed a blank frame, because Aleph sets frame-ancestors. The
 * API is open for public collections without a key, so the hits can be read
 * server-side and rendered as rows.
 *
 * Only public collections are searched. An API key would widen this to
 * collections the key holder has been granted, and reading those is an access
 * decision belonging to whoever granted them — not something to inherit
 * silently from an environment variable.
 */
const searchSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.string().optional(),
        schema: z.string().optional(),
        properties: z.record(z.array(z.unknown())).optional(),
        collection: z
          .object({ label: z.string().optional() })
          .partial()
          .optional(),
        links: z.object({ ui: z.string().optional() }).partial().optional(),
      }),
    )
    .default([]),
});

export type AlephSearch = z.infer<typeof searchSchema>;

/** First string value of a property, which is where Aleph puts names/dates. */
function firstString(
  properties: Record<string, unknown[]> | undefined,
  key: string,
): string | null {
  const values = properties?.[key];
  if (!Array.isArray(values)) return null;
  const first = values.find((v) => typeof v === "string");
  return typeof first === "string" && first.trim().length > 0 ? first : null;
}

export function normalizeAleph(
  payload: AlephSearch,
  term: string,
): DatasetObservation[] {
  const hits: DatasetObservation[] = [];

  for (const entity of payload.results) {
    const properties = entity.properties;
    const name =
      firstString(properties, "name") ??
      firstString(properties, "title") ??
      entity.id ??
      null;
    if (name === null) continue;

    hits.push({
      kind: "dataset-hit",
      datasetId: entity.collection?.label ?? "aleph",
      title: name,
      entityType: entity.schema ?? null,
      matchedTerm: term,
      url:
        entity.links?.ui ??
        (entity.id === undefined
          ? null
          : `https://aleph.occrp.org/entities/${entity.id}`),
      date:
        firstString(properties, "date") ??
        firstString(properties, "incorporationDate") ??
        null,
      excerpt: null,
      entities: [],
    });
  }

  return hits;
}

export async function fetchAleph(
  subject: Subject,
): Promise<DatasetObservation[]> {
  const url =
    `https://aleph.occrp.org/api/2/entities?q=${encodeURIComponent(subject.value)}` +
    `&limit=50`;

  const key = process.env["ALEPH_API_KEY"]?.trim() ?? "";
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(key.length > 0 ? { authorization: `ApiKey ${key}` } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Aleph responded ${response.status}`);
  }

  return normalizeAleph(
    searchSchema.parse(await response.json()),
    subject.value,
  );
}

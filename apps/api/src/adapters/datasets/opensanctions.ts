import { z } from "zod";
import type { SanctionMatch, Subject } from "@scout/sources";
import {
  classifyDesignation,
  dedupeEntities,
  requireSource,
} from "@scout/sources";

export const openSanctionsSource = requireSource("opensanctions");

const REQUEST_TIMEOUT_MS = 15_000;

const entitySchema = z.object({
  id: z.string(),
  caption: z.string().default(""),
  schema: z.string().default("Thing"),
  datasets: z.array(z.string()).default([]),
  score: z.number().nullable().default(null),
  properties: z
    .object({
      country: z.array(z.string()).default([]),
      topics: z.array(z.string()).default([]),
      email: z.array(z.string()).default([]),
      website: z.array(z.string()).default([]),
      name: z.array(z.string()).default([]),
    })
    .partial()
    .default({}),
});

const searchSchema = z.object({
  results: z.array(entitySchema).default([]),
});

export type OpenSanctionsSearch = z.infer<typeof searchSchema>;

export function normalizeOpenSanctions(
  payload: OpenSanctionsSearch,
): SanctionMatch[] {
  return payload.results.map((entity) => {
    const topics = entity.properties.topics ?? [];
    const datasets = [...entity.datasets].sort();
    // Classification lives in @scout/sources so the API and the dashboard
    // cannot disagree about what a listing claims.
    const designation = classifyDesignation(topics);

    return {
      kind: "sanction-match" as const,
      entityId: entity.id,
      caption: entity.caption,
      schema: entity.schema,
      datasets,
      score: entity.score,
      countries: [...(entity.properties.country ?? [])].sort(),
      topics: [...topics].sort(),
      designation,
      sanctioned: designation === "sanctioned",
      // Structured fields, so these are high confidence — the provider has
      // already decided this email belongs to this entity.
      entities: dedupeEntities([
        ...(entity.properties.email ?? []).map((value) => ({
          kind: "email" as const,
          value: value.toLowerCase(),
          confidence: "high" as const,
          fromSourceId: openSanctionsSource.id,
        })),
        ...(entity.properties.website ?? []).map((value) => ({
          kind: "domain" as const,
          value: value.toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? value,
          confidence: "high" as const,
          fromSourceId: openSanctionsSource.id,
        })),
        ...(entity.schema === "Person" || entity.schema === "Company"
          ? [
              {
                kind: (entity.schema === "Person"
                  ? "person"
                  : "company") as "person" | "company",
                value: entity.caption,
                confidence: "high" as const,
                fromSourceId: openSanctionsSource.id,
              },
            ]
          : []),
      ]),
    };
  });
}

export async function fetchOpenSanctions(
  subject: Subject,
): Promise<SanctionMatch[]> {
  const key = process.env["OPENSANCTIONS_API_KEY"]?.trim();
  if (key === undefined || key.length === 0) {
    throw new Error("OPENSANCTIONS_API_KEY is not configured");
  }

  const url = `https://api.opensanctions.org/search/default?q=${encodeURIComponent(
    subject.value.trim(),
  )}&limit=25`;

  const response = await fetch(url, {
    // Key in a header, never the URL.
    headers: { authorization: `ApiKey ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`OpenSanctions responded ${response.status}`);
  }

  return normalizeOpenSanctions(searchSchema.parse(await response.json()));
}

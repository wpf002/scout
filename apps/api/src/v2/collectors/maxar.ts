import { z } from "zod";
import { defineCollector, type CollectMeta, type ObservationInput } from "@scout/fusion";
import { getJson } from "../../live/http.js";

import { centroid, imageryParamsSchema, type ImageryParams } from "./imagery.js";

/**
 * Maxar, catalogue only.
 *
 * Maxar imagery is tasked and sold under contract; the Discovery API is a
 * STAC catalogue of what has been collected. Without a key the adapter is
 * inert. With one it records which scenes exist over the box in the
 * window. Ordering or downloading imagery is a contract action and is not
 * done here.
 */

export const MAXAR_KEY_ENV = "MAXAR_API_KEY";
const SEARCH_URL = "https://api.maxar.com/discovery/v1/search";

const stacSchema = z.object({
  features: z.array(z.object({
    id: z.string(),
    collection: z.string().optional(),
    properties: z.object({ datetime: z.string(), "eo:cloud_cover": z.number().optional(), platform: z.string().optional(), gsd: z.number().optional() }),
  })),
});

export interface MaxarScene {
  itemId: string;
  collection: string | null;
  sensedAt: string;
  cloudCoverPct: number | null;
  platform: string | null;
  gsdM: number | null;
}

export async function searchMaxar(params: ImageryParams, apiKey: string): Promise<MaxarScene[]> {
  const body = JSON.stringify({
    bbox: params.bbox,
    datetime: `${params.from.toISOString()}/${params.to.toISOString()}`,
    limit: 50,
    filter: `eo:cloud_cover <= ${params.maxCloudPct}`,
    "filter-lang": "cql2-text",
  });
  const raw = await getJson(SEARCH_URL, { method: "POST", body, timeoutMs: 30_000, headers: { "maxar-api-key": apiKey, "content-type": "application/json" } });
  return stacSchema
    .parse(raw)
    .features.map((f) => ({
      itemId: f.id,
      collection: f.collection ?? null,
      sensedAt: f.properties.datetime,
      cloudCoverPct: f.properties["eo:cloud_cover"] === undefined ? null : Math.round(f.properties["eo:cloud_cover"]),
      platform: f.properties.platform ?? null,
      gsdM: f.properties.gsd ?? null,
    }))
    .sort((a, b) => b.sensedAt.localeCompare(a.sensedAt))
    .slice(0, params.maxScenes);
}

export function normalizeMaxar(raw: unknown, meta: CollectMeta): ObservationInput[] {
  const run = raw as { params: ImageryParams; scenes: MaxarScene[] } | null;
  if (run === null || typeof run !== "object" || !Array.isArray(run.scenes)) return [];
  const at = centroid(run.params.bbox);
  return run.scenes.map((s) => ({
    sourceId: maxarCollector.id,
    authorizationId: meta.authorizationId,
    collectedAt: meta.collectedAt,
    observedAt: new Date(s.sensedAt),
    rawPayload: s,
    normalizedPayload: { provider: "maxar", itemId: s.itemId, collection: s.collection, sensedAt: s.sensedAt, cloudCoverPct: s.cloudCoverPct, platform: s.platform, gsdM: s.gsdM, bbox: run.params.bbox, stored: false },
    position: at,
    confidenceBp: null,
    indeterminate: false,
    entityKind: "LOCATION" as const,
    ...(meta.caseId === undefined ? {} : { caseId: meta.caseId }),
    identifiers: [],
  }));
}

const base = defineCollector(
  {
    id: "maxar-catalog",
    name: "Maxar (catalogue)",
    sourceClass: "SATELLITE",
    licensingTerms:
      "Commercial, tasked imagery under a Maxar contract held by the customer; MAXAR_API_KEY is that contract's credential. This adapter searches the Discovery catalogue and records scene metadata only. " +
      "Ordering or downloading imagery is a contract action and is not done here.",
    tosUrl: "https://www.maxar.com/legal/terms-of-use",
    rateLimit: { perMinute: 30 },
    refreshCadenceSeconds: 24 * 60 * 60,
    spatialResolutionMeters: 1,
    temporalLagSeconds: 24 * 60 * 60,
    credentialsRef: MAXAR_KEY_ENV,
  },
  normalizeMaxar,
);

export const maxarCollector = {
  ...base,
  entityKind: "LOCATION" as const,
  subjectRequired: false,
  configuredBy: MAXAR_KEY_ENV,
  paramsSchema: imageryParamsSchema,
  async fetch(input: { params?: Record<string, unknown> | undefined }) {
    const params = imageryParamsSchema.parse(input.params ?? {});
    const key = process.env[MAXAR_KEY_ENV]?.trim() ?? "";
    if (key === "") throw new Error(`Maxar needs ${MAXAR_KEY_ENV}.`);
    return { params, scenes: await searchMaxar(params, key) };
  },
};

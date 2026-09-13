import { z } from "zod";
import { defineCollector, type CollectMeta, type ObservationInput } from "@scout/fusion";
import { getJson } from "../../live/http.js";

import { centroid, imageryParamsSchema, type ImageryParams } from "./imagery.js";

/**
 * Planet, catalogue only.
 *
 * Planet's imagery is sold under contract. What this adapter does without
 * one is nothing (no key, inert); with a key it searches the Data API for
 * PlanetScope scenes over the box and records what exists: when, how
 * cloudy, which item. Downloading a scene means activating an asset under
 * the contract's quota, which this adapter deliberately does not do; the
 * observation says a scene exists and who holds it.
 */

export const PLANET_KEY_ENV = "PLANET_API_KEY";
const SEARCH_URL = "https://api.planet.com/data/v1/quick-search";

const searchSchema = z.object({
  features: z.array(z.object({
    id: z.string(),
    properties: z.object({ acquired: z.string(), cloud_cover: z.number().optional(), item_type: z.string().optional(), satellite_id: z.string().optional(), gsd: z.number().optional() }),
  })),
});

export interface PlanetScene {
  itemId: string;
  itemType: string;
  acquired: string;
  cloudCoverPct: number | null;
  satelliteId: string | null;
  gsdM: number | null;
}

export async function searchPlanet(params: ImageryParams, apiKey: string): Promise<PlanetScene[]> {
  const [w, s, e, n] = params.bbox;
  const body = JSON.stringify({
    item_types: ["PSScene"],
    filter: {
      type: "AndFilter",
      config: [
        { type: "GeometryFilter", field_name: "geometry", config: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } },
        { type: "DateRangeFilter", field_name: "acquired", config: { gte: params.from.toISOString(), lte: params.to.toISOString() } },
        { type: "RangeFilter", field_name: "cloud_cover", config: { lte: params.maxCloudPct / 100 } },
      ],
    },
  });
  const raw = await getJson(SEARCH_URL, {
    method: "POST", body, timeoutMs: 30_000,
    headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`, "content-type": "application/json" },
  });
  return searchSchema
    .parse(raw)
    .features.map((f) => ({
      itemId: f.id,
      itemType: f.properties.item_type ?? "PSScene",
      acquired: f.properties.acquired,
      cloudCoverPct: f.properties.cloud_cover === undefined ? null : Math.round(f.properties.cloud_cover * 100),
      satelliteId: f.properties.satellite_id ?? null,
      gsdM: f.properties.gsd ?? null,
    }))
    .sort((a, b) => b.acquired.localeCompare(a.acquired))
    .slice(0, params.maxScenes);
}

export function normalizePlanet(raw: unknown, meta: CollectMeta): ObservationInput[] {
  const run = raw as { params: ImageryParams; scenes: PlanetScene[] } | null;
  if (run === null || typeof run !== "object" || !Array.isArray(run.scenes)) return [];
  const at = centroid(run.params.bbox);
  return run.scenes.map((s) => ({
    sourceId: planetCollector.id,
    authorizationId: meta.authorizationId,
    collectedAt: meta.collectedAt,
    observedAt: new Date(s.acquired),
    rawPayload: s,
    normalizedPayload: { provider: "planet", itemType: s.itemType, itemId: s.itemId, acquired: s.acquired, cloudCoverPct: s.cloudCoverPct, satelliteId: s.satelliteId, gsdM: s.gsdM, bbox: run.params.bbox, stored: false },
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
    id: "planet-scenes",
    name: "Planet (catalogue)",
    sourceClass: "SATELLITE",
    licensingTerms:
      "Commercial imagery under a Planet contract held by the customer; PLANET_API_KEY is that contract's credential. This adapter searches the catalogue and records scene metadata only. " +
      "Activating and downloading a scene draws on the contract's quota and is not done here.",
    tosUrl: "https://www.planet.com/terms-of-use/",
    rateLimit: { perMinute: 30 },
    refreshCadenceSeconds: 24 * 60 * 60,
    spatialResolutionMeters: 3,
    temporalLagSeconds: 12 * 60 * 60,
    credentialsRef: PLANET_KEY_ENV,
  },
  normalizePlanet,
);

export const planetCollector = {
  ...base,
  entityKind: "LOCATION" as const,
  subjectRequired: false,
  configuredBy: PLANET_KEY_ENV,
  paramsSchema: imageryParamsSchema,
  async fetch(input: { params?: Record<string, unknown> | undefined }) {
    const params = imageryParamsSchema.parse(input.params ?? {});
    const key = process.env[PLANET_KEY_ENV]?.trim() ?? "";
    if (key === "") throw new Error(`Planet needs ${PLANET_KEY_ENV}.`);
    return { params, scenes: await searchPlanet(params, key) };
  },
};

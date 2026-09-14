import { z } from "zod";
import { defineCollector, type CollectMeta, type ObservationInput } from "@scout/fusion";
import { getJson, getText, UpstreamError } from "../../live/http.js";
import { cached } from "../../live/cache.js";

import { centroid, imageryParamsSchema, storeScene, type ImageryParams, type StoredScene } from "./imagery.js";

/**
 * Sentinel-2 via Sentinel Hub.
 *
 * ESA's Copernicus programme publishes Sentinel-2 as open data; Sentinel
 * Hub is the API in front of it, with its own terms and a free tier. A run
 * is: an OAuth token, a catalogue search for scenes over the box in the
 * window under the cloud limit, then for each scene (newest first, capped)
 * one GeoTIFF and one PNG preview over the box, stored once and indexed
 * (`imagery.ts`). The observation is the scene over the box: where, when,
 * how cloudy, and which stored tile shows it.
 */

export const SENTINELHUB_ID_ENV = "SENTINELHUB_CLIENT_ID";
export const SENTINELHUB_SECRET_ENV = "SENTINELHUB_CLIENT_SECRET";
// Copernicus Data Space Ecosystem by default: that is the free tier, and its
// OAuth clients (created at dataspace.copernicus.eu) authenticate against the
// CDSE identity server and call the sh.dataspace.copernicus.eu APIs, not the
// legacy Sentinel Hub host. Both are overridable for a legacy or enterprise
// account.
const BASE = (process.env["SENTINELHUB_BASE_URL"]?.trim() || "https://sh.dataspace.copernicus.eu").replace(/\/$/, "");
const TOKEN_URL = process.env["SENTINELHUB_TOKEN_URL"]?.trim() || "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const COLLECTION = "sentinel-2-l2a";
const NATIVE_M = 10;

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().optional() });
const catalogSchema = z.object({
  features: z.array(z.object({ id: z.string(), properties: z.object({ datetime: z.string(), "eo:cloud_cover": z.number().optional() }) })),
});

async function token(): Promise<string> {
  const id = process.env[SENTINELHUB_ID_ENV]?.trim() ?? "";
  const secret = process.env[SENTINELHUB_SECRET_ENV]?.trim() ?? "";
  if (id === "" || secret === "") throw new Error(`Sentinel Hub needs ${SENTINELHUB_ID_ENV} and ${SENTINELHUB_SECRET_ENV}.`);
  return cached("sentinelhub:token", 50 * 60_000, async () => {
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }).toString();
    const raw = await getText(TOKEN_URL, {
      method: "POST", body, timeoutMs: 20_000, headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    return tokenSchema.parse(JSON.parse(raw)).access_token;
  });
}

export interface SceneHit {
  sceneId: string;
  sensedAt: Date;
  cloudCoverPct: number | null;
}

export async function searchScenes(params: ImageryParams, bearer: string): Promise<SceneHit[]> {
  const body = JSON.stringify({
    collections: [COLLECTION],
    bbox: params.bbox,
    datetime: `${params.from.toISOString()}/${params.to.toISOString()}`,
    limit: 50,
    filter: `eo:cloud_cover <= ${params.maxCloudPct}`,
    "filter-lang": "cql2-text",
    fields: { include: ["id", "properties.datetime", "properties.eo:cloud_cover"] },
  });
  const raw = await getJson(`${BASE}/api/v1/catalog/1.0.0/search`, {
    // CDSE's STAC search negotiates on geo+json and answers 406 to a plain
    // application/json Accept; the legacy host accepts geo+json too.
    method: "POST", body, timeoutMs: 30_000, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/geo+json" },
  });
  return catalogSchema
    .parse(raw)
    .features.map((f) => ({ sceneId: f.id, sensedAt: new Date(f.properties.datetime), cloudCoverPct: f.properties["eo:cloud_cover"] === undefined ? null : Math.round(f.properties["eo:cloud_cover"]) }))
    .sort((a, b) => b.sensedAt.getTime() - a.sensedAt.getTime())
    .slice(0, params.maxScenes);
}

/** True colour, gain-corrected, the way every Sentinel-2 quick look is made. */
const EVALSCRIPT = `//VERSION=3
function setup() { return { input: ["B04", "B03", "B02", "dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) { return [2.5 * s.B04, 2.5 * s.B03, 2.5 * s.B02, s.dataMask]; }`;

async function render(bearer: string, params: ImageryParams, scene: SceneHit, size: { width: number; height: number }, format: "image/tiff" | "image/png"): Promise<Uint8Array> {
  const from = new Date(scene.sensedAt.getTime() - 60_000).toISOString();
  const to = new Date(scene.sensedAt.getTime() + 60_000).toISOString();
  const body = JSON.stringify({
    input: {
      bounds: { bbox: params.bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
      data: [{ type: COLLECTION, dataFilter: { timeRange: { from, to }, maxCloudCoverage: 100, mosaickingOrder: "mostRecent" } }],
    },
    output: { width: size.width, height: size.height, responses: [{ identifier: "default", format: { type: format } }] },
    evalscript: EVALSCRIPT,
  });
  const response = await fetch(`${BASE}/api/v1/process`, {
    method: "POST", body, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: format },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new UpstreamError(`${BASE}/api/v1/process`, response.status, (await response.text()).slice(0, 300));
  return new Uint8Array(await response.arrayBuffer());
}

export interface Sentinel2Run {
  params: ImageryParams;
  scenes: StoredScene[];
}

export function normalizeScenes(raw: unknown, meta: CollectMeta): ObservationInput[] {
  const run = raw as Sentinel2Run | null;
  if (run === null || typeof run !== "object" || !Array.isArray(run.scenes)) return [];
  const at = centroid(run.params.bbox);
  return run.scenes.map((s) => ({
    sourceId: sentinel2Collector.id,
    authorizationId: meta.authorizationId,
    collectedAt: meta.collectedAt,
    observedAt: s.sensedAt,
    rawPayload: s,
    normalizedPayload: {
      provider: "sentinel-hub",
      collection: COLLECTION,
      sceneId: s.sceneId,
      sensedAt: s.sensedAt.toISOString(),
      cloudCoverPct: s.cloudCoverPct,
      bbox: s.bbox,
      tileId: s.tileId,
      previewKey: s.previewKey,
      resolutionM: s.resolutionM,
    },
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
    id: "sentinel-2",
    name: "Sentinel-2 imagery (Sentinel Hub)",
    sourceClass: "SATELLITE",
    licensingTerms:
      "Copernicus Sentinel-2 data, free and open under the Copernicus Sentinel Data Terms and Conditions (attribution: contains modified Copernicus Sentinel data). " +
      "Accessed through Sentinel Hub under its terms of service and a free-tier processing-unit quota; stored tiles are indexed and served from Scout's own bucket so a scene is requested once.",
    tosUrl: "https://www.sentinel-hub.com/tos/",
    rateLimit: { perMinute: 10 },
    refreshCadenceSeconds: 5 * 24 * 60 * 60,
    spatialResolutionMeters: NATIVE_M,
    temporalLagSeconds: 24 * 60 * 60,
    credentialsRef: SENTINELHUB_ID_ENV,
  },
  normalizeScenes,
);

export const sentinel2Collector = {
  ...base,
  entityKind: "LOCATION" as const,
  subjectRequired: false,
  configuredBy: SENTINELHUB_ID_ENV,
  paramsSchema: imageryParamsSchema,
  async fetch(input: { params?: Record<string, unknown> | undefined; authorizationId: string; caseId: string }): Promise<Sentinel2Run> {
    const params = imageryParamsSchema.parse(input.params ?? {});
    const bearer = await token();
    const hits = await searchScenes(params, bearer);
    const scenes: StoredScene[] = [];
    for (const hit of hits) {
      scenes.push(
        await storeScene({
          sourceId: base.id,
          authorizationId: input.authorizationId,
          caseId: input.caseId,
          bbox: params.bbox,
          nativeResolutionM: NATIVE_M,
          scene: {
            ...hit,
            render: async (size) => ({
              tiff: await render(bearer, params, hit, size, "image/tiff"),
              png: await render(bearer, params, hit, size, "image/png"),
              format: "image/tiff",
            }),
          },
        }),
      );
    }
    return { params, scenes };
  },
};

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors.js";

/**
 * Live geospatial layers.
 *
 * Each layer is a public feed normalised to GeoJSON so the map handles one
 * shape rather than eight. Fetching them server-side rather than from the
 * browser is what makes that possible — most of these send no CORS headers,
 * and several are rate limited per address, which a shared cache here turns
 * from a per-user budget into a per-instance one.
 *
 * Everything is cached in memory with a per-layer TTL chosen from how fast the
 * underlying thing actually moves. Aircraft move continuously; submarine
 * cables do not.
 */

const REQUEST_TIMEOUT_MS = 20_000;
const UA = "Scout-OSINT/0.1 (+authorized-engagement-tooling)";

export interface Feature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

interface CacheEntry {
  at: number;
  value: FeatureCollection;
}

const cache = new Map<string, CacheEntry>();

/** Exposed for tests. */
export function clearLiveCache(): void {
  cache.clear();
}

async function cached(
  key: string,
  ttlMs: number,
  load: () => Promise<FeatureCollection>,
): Promise<FeatureCollection> {
  const hit = cache.get(key);
  if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.value;

  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

const point = (
  lon: number,
  lat: number,
  properties: Record<string, unknown>,
): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties,
});

// ── Earthquakes ────────────────────────────────────────────────────────────

const usgsSchema = z.object({
  features: z
    .array(
      z.object({
        id: z.string().optional(),
        properties: z
          .object({
            mag: z.number().nullable().default(null),
            place: z.string().nullable().default(null),
            time: z.number().nullable().default(null),
            url: z.string().nullable().default(null),
          })
          .partial(),
        geometry: z
          .object({ coordinates: z.array(z.number()) })
          .nullable()
          .default(null),
      }),
    )
    .default([]),
});

async function earthquakes(): Promise<FeatureCollection> {
  const raw = await getJson(
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
  );
  const parsed = usgsSchema.parse(raw);

  return {
    type: "FeatureCollection",
    features: parsed.features.flatMap((feature) => {
      const coords = feature.geometry?.coordinates;
      if (coords === undefined || coords.length < 2) return [];
      const [lon, lat, depth] = coords;
      if (typeof lon !== "number" || typeof lat !== "number") return [];

      return [
        point(lon, lat, {
          layer: "earthquakes",
          id: feature.id ?? `${lon},${lat}`,
          label: feature.properties.place ?? "Earthquake",
          magnitude: feature.properties.mag,
          depthKm: depth ?? null,
          at: feature.properties.time,
          url: feature.properties.url,
        }),
      ];
    }),
  };
}

// ── Flights ────────────────────────────────────────────────────────────────

const openSkySchema = z.object({
  time: z.number().optional(),
  states: z.array(z.array(z.unknown())).nullable().default([]),
});

/**
 * OpenSky's anonymous tier is heavily rate limited, and the whole-world query
 * is the most expensive one it serves. The bounding box is required rather
 * than optional for that reason — an unbounded request is how the shared
 * anonymous budget gets spent in one page load.
 */
async function flights(bbox: string): Promise<FeatureCollection> {
  const [lamin, lomin, lamax, lomax] = bbox.split(",").map(Number);
  if ([lamin, lomin, lamax, lomax].some((n) => !Number.isFinite(n))) {
    throw new Error("A bounding box of lamin,lomin,lamax,lomax is required.");
  }

  const raw = await getJson(
    `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`,
  );
  const parsed = openSkySchema.parse(raw);

  return {
    type: "FeatureCollection",
    features: (parsed.states ?? []).flatMap((state) => {
      // OpenSky returns positional arrays, not objects. Index 5 is longitude
      // and 6 is latitude — reversed from the usual lat/lon order.
      const icao = state[0];
      const callsign = state[1];
      const country = state[2];
      const lon = state[5];
      const lat = state[6];
      const altitude = state[7];
      const heading = state[10];

      if (typeof lon !== "number" || typeof lat !== "number") return [];

      return [
        point(lon, lat, {
          layer: "flights",
          id: typeof icao === "string" ? icao : `${lon},${lat}`,
          label:
            typeof callsign === "string" && callsign.trim().length > 0
              ? callsign.trim()
              : "Unknown",
          country: typeof country === "string" ? country : null,
          altitudeM: typeof altitude === "number" ? altitude : null,
          heading: typeof heading === "number" ? heading : 0,
        }),
      ];
    }),
  };
}

// ── Space weather ──────────────────────────────────────────────────────────

/**
 * NOAA returns objects here, not the positional arrays several of its other
 * products use. Assuming the array shape produced a schema error that read as
 * a dead feed rather than a wrong parser.
 */
const kIndexSchema = z.array(
  z.object({
    time_tag: z.string(),
    Kp: z.number().nullable().default(null),
  }),
);

/**
 * Geomagnetic activity is planetary — it has no single coordinate.
 *
 * Rather than inventing a location, the reading is drawn as a band across the
 * auroral latitudes, which is where a K-index actually means something to
 * anyone looking at a map.
 */
async function spaceWeather(): Promise<FeatureCollection> {
  const raw = await getJson(
    "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
  );
  const rows = kIndexSchema.parse(raw);
  const latest = rows[rows.length - 1];
  const kp = latest?.Kp ?? null;

  // The auroral oval moves toward the equator as Kp rises. This is a rough
  // visual cue, not a forecast, and is labelled as such.
  const latitude = kp === null ? 67 : Math.max(45, 67 - kp * 2.5);

  const ring = (lat: number) =>
    Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat]);

  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: ring(latitude) },
        properties: {
          layer: "space_weather",
          id: "aurora-north",
          label: `Planetary K-index ${kp ?? "?"}`,
          kp,
          at: latest?.time_tag ?? null,
        },
      },
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates: ring(-latitude) },
        properties: {
          layer: "space_weather",
          id: "aurora-south",
          label: `Planetary K-index ${kp ?? "?"}`,
          kp,
          at: latest?.time_tag ?? null,
        },
      },
    ],
  };
}

// ── Natural events ─────────────────────────────────────────────────────────

const eonetSchema = z.object({
  events: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().default(""),
        link: z.string().optional(),
        categories: z
          .array(z.object({ title: z.string().optional() }))
          .default([]),
        geometry: z
          .array(
            z.object({
              date: z.string().optional(),
              type: z.string().optional(),
              coordinates: z.unknown(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

/** NASA EONET — wildfires, storms, volcanoes, floods. Keyless. */
async function incidents(): Promise<FeatureCollection> {
  const raw = await getJson(
    "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=500",
  );
  const parsed = eonetSchema.parse(raw);

  return {
    type: "FeatureCollection",
    features: parsed.events.flatMap((event) => {
      // An event carries a track of geometries; the last is where it is now.
      const latest = event.geometry[event.geometry.length - 1];
      const coords = latest?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return [];
      const [lon, lat] = coords;
      if (typeof lon !== "number" || typeof lat !== "number") return [];

      return [
        point(lon, lat, {
          layer: "global_incidents",
          id: event.id ?? event.title,
          label: event.title,
          category: event.categories[0]?.title ?? null,
          at: latest?.date ?? null,
          url: event.link ?? null,
        }),
      ];
    }),
  };
}

// ── Registry ───────────────────────────────────────────────────────────────

interface LayerDef {
  id: string;
  name: string;
  ttlMs: number;
  needsBbox: boolean;
  load: (bbox: string) => Promise<FeatureCollection>;
}

/**
 * TTL per layer, from how fast the underlying thing moves.
 *
 * Aircraft are continuous and the feed is rate limited, so 20 seconds is both
 * fresh enough to look live and slow enough to stay inside the anonymous
 * budget. Earthquakes are reported in minutes. Natural events last days.
 */
export const LAYERS: LayerDef[] = [
  {
    id: "earthquakes",
    name: "Earthquakes",
    ttlMs: 60_000,
    needsBbox: false,
    load: earthquakes,
  },
  {
    id: "flights",
    name: "Flights",
    ttlMs: 20_000,
    needsBbox: true,
    load: flights,
  },
  {
    id: "global_incidents",
    name: "Global Incidents",
    ttlMs: 15 * 60_000,
    needsBbox: false,
    load: incidents,
  },
  {
    id: "space_weather",
    name: "Space Weather",
    ttlMs: 10 * 60_000,
    needsBbox: false,
    load: spaceWeather,
  },
];

const BY_ID = new Map(LAYERS.map((layer) => [layer.id, layer]));

export async function registerLiveRoutes(app: FastifyInstance): Promise<void> {
  /** What layers exist, so the client never hardcodes the roster. */
  app.get("/live/layers", async () => ({
    count: LAYERS.length,
    layers: LAYERS.map((layer) => ({
      id: layer.id,
      name: layer.name,
      needsBbox: layer.needsBbox,
      refreshSeconds: Math.round(layer.ttlMs / 1000),
    })),
  }));

  app.get("/live/:layer", async (request, reply) => {
    const params = z
      .object({ layer: z.string().min(1) })
      .safeParse(request.params);
    if (!params.success) throw badRequest("A layer is required.");

    const layer = BY_ID.get(params.data.layer);
    if (layer === undefined) {
      throw badRequest(`Unknown layer "${params.data.layer}".`);
    }

    const query = z
      .object({ bbox: z.string().optional() })
      .safeParse(request.query);
    const bbox = query.success ? (query.data.bbox ?? "") : "";

    if (layer.needsBbox && bbox.length === 0) {
      throw badRequest(`${layer.name} needs a bbox of lamin,lomin,lamax,lomax.`);
    }

    try {
      const collection = await cached(
        `${layer.id}:${layer.needsBbox ? bbox : ""}`,
        layer.ttlMs,
        () => layer.load(bbox),
      );
      return reply.header("cache-control", "no-store").send(collection);
    } catch (error) {
      // A dead upstream must not take the map down with it. The layer reports
      // empty with a reason, and every other layer keeps drawing.
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(200).send({
        type: "FeatureCollection",
        features: [],
        error: message,
      });
    }
  });
}

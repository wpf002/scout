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

async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": UA, ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.json();
}

/**
 * Fetch several feeds and keep whatever answers.
 *
 * Used by the layers that are a union of regional sources. One city's camera
 * API being down should thin the layer, not empty it — an operator reading a
 * blank map cannot tell "nothing there" from "the fetch failed".
 */
async function merge(
  loaders: Array<() => Promise<Feature[]>>,
): Promise<FeatureCollection> {
  const settled = await Promise.allSettled(loaders.map((load) => load()));
  const features = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (features.length === 0 && settled.length > 0) {
    const first = settled.find((r) => r.status === "rejected");
    if (first !== undefined && first.status === "rejected") {
      throw first.reason instanceof Error
        ? first.reason
        : new Error(String(first.reason));
    }
  }
  return { type: "FeatureCollection", features };
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

// ── Submarine cables ───────────────────────────────────────────────────────

const cableSchema = z.object({
  features: z
    .array(
      z.object({
        properties: z
          .object({
            id: z.string().optional(),
            name: z.string().optional(),
            color: z.string().optional(),
          })
          .partial(),
        geometry: z.object({
          type: z.string(),
          coordinates: z.unknown().transform((value) => value ?? null),
        }),
      }),
    )
    .default([]),
});

/**
 * The physical internet.
 *
 * Cables are the one layer here that does not move, so it is cached for a day
 * — the payload is around 700 KB and re-fetching it on a timer would be pure
 * waste. Landing points are deliberately left out: they roughly double the
 * weight for a set of dots that sit on the ends of lines already drawn.
 */
async function cables(): Promise<FeatureCollection> {
  const raw = await getJson(
    "https://www.submarinecablemap.com/api/v3/cable/cable-geo.json",
  );
  const parsed = cableSchema.parse(raw);

  return {
    type: "FeatureCollection",
    features: parsed.features.map((feature) => ({
      type: "Feature" as const,
      geometry: feature.geometry,
      properties: {
        layer: "cables",
        id: feature.properties.id ?? feature.properties.name ?? "cable",
        label: feature.properties.name ?? "Submarine cable",
      },
    })),
  };
}

// ── News ───────────────────────────────────────────────────────────────────

const gdeltSchema = z.object({
  features: z
    .array(
      z.object({
        properties: z
          .object({
            name: z.string().optional(),
            html: z.string().optional(),
            url: z.string().optional(),
            urltone: z.number().optional(),
            urlpubtimedate: z.string().optional(),
            shareimage: z.string().optional(),
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

/**
 * GDELT's geocoded news, by theme.
 *
 * One query per theme rather than one broad query: GDELT scores relevance
 * per query, and a catch-all returns whatever is loudest globally rather than
 * the categories an operator actually watches. Duplicates across themes are
 * collapsed by URL.
 *
 * Plain HTTP, deliberately. `api.gdeltproject.org` does not answer on 443 at
 * all — the connection times out rather than being refused, which reads as a
 * dead feed. Nothing authenticates this request and no subject data is in it,
 * so the exposure is that a network observer learns Scout reads the news; the
 * alternative is not having the layer. It is fetched here rather than from the
 * browser, so no page is downgraded to mixed content.
 *
 * Each theme is capped. GDELT returns around 700 KB per query and three
 * uncapped themes would put 2 MB across the wire for a layer of dots.
 */
const NEWS_PER_THEME = 400;

const NEWS_THEMES = [
  { theme: "PROTEST", label: "Protest" },
  { theme: "ARMEDCONFLICT", label: "Armed conflict" },
  { theme: "NATURAL_DISASTER", label: "Disaster" },
];

async function news(): Promise<FeatureCollection> {
  const seen = new Set<string>();

  const collection = await merge(
    NEWS_THEMES.map(({ theme, label }) => async () => {
      const raw = await getJson(
        `http://api.gdeltproject.org/api/v1/gkg_geojson?QUERY=${theme}&TIMESPAN=180`,
      );
      const parsed = gdeltSchema.parse(raw);

      return parsed.features.slice(0, NEWS_PER_THEME).flatMap((feature) => {
        const coords = feature.geometry?.coordinates;
        if (coords === undefined || coords.length < 2) return [];
        const [lon, lat] = coords;
        if (typeof lon !== "number" || typeof lat !== "number") return [];

        const url = feature.properties.url ?? "";
        if (url.length > 0) {
          if (seen.has(url)) return [];
          seen.add(url);
        }

        return [
          point(lon, lat, {
            layer: "live_news",
            id: url.length > 0 ? url : `${lon},${lat}`,
            label: feature.properties.name ?? label,
            theme: label,
            tone: feature.properties.urltone ?? null,
            at: feature.properties.urlpubtimedate ?? null,
            url: url.length > 0 ? url : null,
          }),
        ];
      });
    }),
  );

  return collection;
}

// ── Vessels ────────────────────────────────────────────────────────────────

const aisSchema = z.object({
  features: z
    .array(
      z.object({
        mmsi: z.number().optional(),
        properties: z
          .object({
            mmsi: z.number().optional(),
            sog: z.number().optional(),
            cog: z.number().optional(),
            heading: z.number().optional(),
            navStat: z.number().optional(),
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

/**
 * Live AIS, from the one authority that publishes it without a key.
 *
 * Digitraffic covers Finnish waters and the northern Baltic, so this is a
 * regional layer, not a world one — which is why it is named for what it
 * actually shows rather than "Maritime". Claiming global vessel coverage and
 * drawing only the Gulf of Bothnia would be worse than drawing nothing.
 *
 * Two request requirements that are easy to miss: it answers 406 without gzip
 * regardless of the Accept header, and it asks callers to identify themselves.
 */
async function vessels(): Promise<FeatureCollection> {
  const raw = await getJson("https://meri.digitraffic.fi/api/ais/v1/locations", {
    "accept-encoding": "gzip",
    "digitraffic-user": "Scout-OSINT/0.1",
  });
  const parsed = aisSchema.parse(raw);

  return {
    type: "FeatureCollection",
    features: parsed.features.flatMap((feature) => {
      const coords = feature.geometry?.coordinates;
      if (coords === undefined || coords.length < 2) return [];
      const [lon, lat] = coords;
      if (typeof lon !== "number" || typeof lat !== "number") return [];

      const mmsi = feature.mmsi ?? feature.properties.mmsi ?? null;
      return [
        point(lon, lat, {
          layer: "vessels",
          id: mmsi === null ? `${lon},${lat}` : String(mmsi),
          label: mmsi === null ? "Vessel" : `MMSI ${mmsi}`,
          speedKn: feature.properties.sog ?? null,
          heading: feature.properties.heading ?? feature.properties.cog ?? 0,
        }),
      ];
    }),
  };
}

// ── Cameras ────────────────────────────────────────────────────────────────

const nycCamSchema = z.array(
  z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    isOnline: z.union([z.string(), z.boolean()]).optional(),
  }),
);

const tflCamSchema = z.array(
  z.object({
    id: z.string().optional(),
    commonName: z.string().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
  }),
);

/**
 * Public traffic cameras.
 *
 * These are the agency feeds that publish positions without a key, so the
 * layer is a handful of cities rather than the world. Each dot carries the
 * operator that published it, because "there is a camera here" means something
 * different coming from a transport authority than from a random aggregator.
 */
async function cameras(): Promise<FeatureCollection> {
  return merge([
    async () => {
      const raw = await getJson("https://webcams.nyctmc.org/api/cameras");
      return nycCamSchema.parse(raw).flatMap((cam) => {
        if (
          typeof cam.longitude !== "number" ||
          typeof cam.latitude !== "number"
        ) {
          return [];
        }
        return [
          point(cam.longitude, cam.latitude, {
            layer: "cameras",
            id: cam.id ?? `${cam.longitude},${cam.latitude}`,
            label: cam.name ?? "Traffic camera",
            operator: "NYC DOT",
          }),
        ];
      });
    },
    async () => {
      const raw = await getJson("https://api.tfl.gov.uk/Place/Type/JamCam");
      return tflCamSchema.parse(raw).flatMap((cam) => {
        if (typeof cam.lon !== "number" || typeof cam.lat !== "number") {
          return [];
        }
        return [
          point(cam.lon, cam.lat, {
            layer: "cameras",
            id: cam.id ?? `${cam.lon},${cam.lat}`,
            label: cam.commonName ?? "Traffic camera",
            operator: "Transport for London",
          }),
        ];
      });
    },
  ]);
}

// ── Aurora ─────────────────────────────────────────────────────────────────

const ovationSchema = z.object({
  "Observation Time": z.string().optional(),
  "Forecast Time": z.string().optional(),
  coordinates: z.array(z.tuple([z.number(), z.number(), z.number()])),
});

/**
 * NOAA's OVATION model — the probability of visible aurora, on a 1-degree
 * grid.
 *
 * The full grid is 65,000 points, nearly all of them zero. Only cells above a
 * visible threshold are kept, and those are thinned on a coarser lattice: the
 * result is a band an operator can read at a glance rather than a solid mask
 * over both poles that hides the map underneath it.
 */
async function aurora(): Promise<FeatureCollection> {
  const raw = await getJson(
    "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json",
  );
  const parsed = ovationSchema.parse(raw);
  const at = parsed["Forecast Time"] ?? parsed["Observation Time"] ?? null;

  return {
    type: "FeatureCollection",
    features: parsed.coordinates.flatMap(([lon, lat, value]) => {
      if (value < 8) return [];
      if (lon % 3 !== 0 || lat % 2 !== 0) return [];

      // The grid runs 0..359; the map wants -180..180.
      const longitude = lon > 180 ? lon - 360 : lon;
      return [
        point(longitude, lat, {
          layer: "aurora",
          id: `${lon},${lat}`,
          label: `Aurora ${value}% chance`,
          probability: value,
          at,
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
  {
    id: "aurora",
    name: "Aurora Forecast",
    ttlMs: 5 * 60_000,
    needsBbox: false,
    load: aurora,
  },
  {
    id: "live_news",
    name: "Live News",
    ttlMs: 5 * 60_000,
    needsBbox: false,
    load: news,
  },
  {
    id: "vessels",
    name: "Vessel Traffic",
    ttlMs: 60_000,
    needsBbox: false,
    load: vessels,
  },
  {
    id: "cameras",
    name: "Traffic Cameras",
    ttlMs: 6 * 60 * 60_000,
    needsBbox: false,
    load: cameras,
  },
  {
    id: "cables",
    name: "Submarine Cables",
    ttlMs: 24 * 60 * 60_000,
    needsBbox: false,
    load: cables,
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

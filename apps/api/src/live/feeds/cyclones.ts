import { z } from "zod";
import { cached } from "../cache.js";
import { getJson } from "../http.js";
import { point, usable, type Feature, type FeatureCollection } from "../types.js";

/**
 * Tropical cyclones, with the official forecast cone.
 *
 * The cone is the point of this layer. A storm's current position is one dot;
 * the cone is where the National Hurricane Center believes the centre will go,
 * and it is what tells an operator which of Scout's forty ports and ten
 * chokepoints sit inside the five-day envelope.
 *
 * It is published as an ArcGIS service whose layer ids shift per storm — a
 * "bin" is reused as storms come and go — so the ids are resolved by name on
 * every fetch. A hardcoded id returns an empty FeatureCollection rather than
 * an error, which would read as "no cone" instead of "wrong layer".
 */

const NHC_STORMS = "https://www.nhc.noaa.gov/CurrentStorms.json";
const NHC_MAP =
  "https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather/MapServer";

const STORM_SCHEMA = z.object({
  activeStorms: z
    .array(
      z.object({
        id: z.string().optional(),
        binNumber: z.string().optional(),
        name: z.string().optional(),
        classification: z.string().optional(),
        intensity: z.union([z.string(), z.number()]).optional(),
        pressure: z.union([z.string(), z.number()]).optional(),
        latitudeNumeric: z.number().optional(),
        longitudeNumeric: z.number().optional(),
        movementDir: z.number().nullable().optional(),
        movementSpeed: z.number().nullable().optional(),
        lastUpdate: z.string().optional(),
      }),
    )
    .default([]),
});

const LAYERS_SCHEMA = z.object({
  layers: z.array(z.object({ id: z.number(), name: z.string() })).default([]),
});

const GEOJSON_SCHEMA = z.object({
  features: z
    .array(
      z.object({
        properties: z.record(z.string(), z.unknown()).default({}),
        geometry: z
          .object({ type: z.string(), coordinates: z.unknown() })
          .nullable()
          .default(null),
      }),
    )
    .default([]),
});

/** Storm strength, from the published classification code. */
const CLASSIFICATION: Record<string, string> = {
  TD: "Tropical Depression",
  TS: "Tropical Storm",
  HU: "Hurricane",
  MH: "Major Hurricane",
  PT: "Post-Tropical",
  STS: "Severe Tropical Storm",
  TY: "Typhoon",
  STY: "Super Typhoon",
};

const DAY_MS = 24 * 60 * 60_000;

/** Layer ids by name, refreshed hourly — they move as storms come and go. */
async function layerIndex(): Promise<Map<string, number>> {
  return cached("nhc-layers", 60 * 60_000, async () => {
    const parsed = LAYERS_SCHEMA.parse(
      await getJson(`${NHC_MAP}/layers?f=json`, { timeoutMs: 45_000 }),
    );
    return new Map(parsed.layers.map((layer) => [layer.name, layer.id]));
  });
}

async function layerGeoJson(id: number) {
  return GEOJSON_SCHEMA.parse(
    await getJson(
      `${NHC_MAP}/${id}/query?where=1%3D1&outFields=*&f=geojson&outSR=4326`,
      { timeoutMs: 30_000 },
    ),
  );
}

export async function cyclones(): Promise<FeatureCollection> {
  const storms = STORM_SCHEMA.parse(
    await getJson(NHC_STORMS, { timeoutMs: 30_000 }),
  ).activeStorms;

  if (storms.length === 0) {
    // A quiet basin is a real answer, and an empty layer that says so is
    // better than one that looks broken.
    return {
      type: "FeatureCollection",
      features: [],
      meta: { storms: 0, note: "No active tropical cyclones." },
    };
  }

  const index = await layerIndex();
  const features: Feature[] = [];

  for (const storm of storms) {
    const bin = storm.binNumber ?? "";
    const name = storm.name ?? "Unnamed";
    const kind = CLASSIFICATION[storm.classification ?? ""] ?? storm.classification ?? "Storm";
    const knots = Number(storm.intensity ?? 0);

    // Colour by strength, on the Saffir-Simpson thresholds in knots.
    const colour =
      knots >= 96 ? "#ff3b52" : knots >= 64 ? "#ff9f0a" : knots >= 34 ? "#ffd60a" : "#5ac8fa";

    if (usable(storm.longitudeNumeric, storm.latitudeNumeric)) {
      features.push(
        point(storm.longitudeNumeric as number, storm.latitudeNumeric as number, {
          layer: "cyclones",
          role: "centre",
          id: storm.id ?? bin,
          label: `${kind} ${name}`,
          storm: name,
          classification: kind,
          windsKts: knots || null,
          pressureMb: Number(storm.pressure ?? 0) || null,
          movement:
            storm.movementDir == null || storm.movementSpeed == null
              ? null
              : `${storm.movementDir}° at ${storm.movementSpeed} kt`,
          at: storm.lastUpdate ?? null,
          url: `https://www.nhc.noaa.gov/`,
          colour,
        }),
      );
    }

    // The cone and the forecast track, resolved by name for this bin.
    for (const [suffix, role] of [
      ["Forecast Cone", "cone"],
      ["Forecast Track", "track"],
    ] as const) {
      const id = index.get(`${bin} ${suffix}`);
      if (id === undefined) continue;

      try {
        const parsed = await layerGeoJson(id);
        for (const feature of parsed.features) {
          if (feature.geometry === null) continue;
          features.push({
            type: "Feature",
            geometry: feature.geometry as Feature["geometry"],
            properties: {
              layer: "cyclones",
              role,
              id: `${bin}-${role}`,
              label:
                role === "cone"
                  ? `${name} — five-day forecast cone`
                  : `${name} — forecast track`,
              storm: name,
              note:
                role === "cone"
                  ? "The cone is where the centre is likely to go, not the extent of the storm. Hazards regularly reach well outside it."
                  : null,
              source: "US National Hurricane Center",
              colour,
            },
          });
        }
      } catch {
        // One missing cone costs that storm its envelope, not the layer.
      }
    }
  }

  return {
    type: "FeatureCollection",
    features,
    meta: {
      storms: storms.length,
      named: storms.map((s) => s.name).filter(Boolean),
      source: "US National Hurricane Center",
    },
  };
}

export const CYCLONE_TTL_MS = 15 * 60_000;
export const CYCLONE_STALE_MS = DAY_MS;

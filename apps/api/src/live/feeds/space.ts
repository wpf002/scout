import { z } from "zod";
import { getJson } from "../http.js";
import { line, point, type FeatureCollection } from "../types.js";

/** Space weather: geomagnetic activity and the auroral ovals. */

const KP_SCHEMA = z.array(
  z.object({
    time_tag: z.string(),
    Kp: z.number().nullable().default(null),
  }),
);

const FLARE_SCHEMA = z.array(
  z.object({
    time_tag: z.string().optional(),
    current_class: z.string().nullable().optional(),
    max_class: z.string().nullable().optional(),
    begin_time: z.string().nullable().optional(),
    max_time: z.string().nullable().optional(),
  }),
);

/**
 * NOAA's storm scale. These are the published G-scale thresholds, not a
 * severity Scout invented.
 */
function stormLevel(kp: number | null): { level: string; colour: string } {
  if (kp === null) return { level: "Unknown", colour: "#8e8e93" };
  if (kp >= 9) return { level: "G5 Extreme", colour: "#ff3b52" };
  if (kp >= 8) return { level: "G4 Severe", colour: "#ff3b52" };
  if (kp >= 7) return { level: "G3 Strong", colour: "#ff9f0a" };
  if (kp >= 6) return { level: "G2 Moderate", colour: "#ffd60a" };
  if (kp >= 5) return { level: "G1 Minor", colour: "#ffd60a" };
  return { level: "Quiet", colour: "#35c46a" };
}

/**
 * Geomagnetic activity is planetary — it has no single coordinate.
 *
 * Rather than inventing a location for it, the reading is drawn as a band
 * across the auroral latitudes, which is where a K-index means something to
 * anyone looking at a map. The band moves toward the equator as Kp rises,
 * which is the physical behaviour it is standing in for.
 */
export async function spaceWeather(): Promise<FeatureCollection> {
  const [kpResult, flareResult] = await Promise.allSettled([
    getJson("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"),
    getJson("https://services.swpc.noaa.gov/json/goes/primary/xray-flares-latest.json"),
  ]);

  if (kpResult.status !== "fulfilled") {
    throw kpResult.reason instanceof Error
      ? kpResult.reason
      : new Error("NOAA did not answer");
  }

  // NOAA returns objects here, not the positional arrays several of its other
  // products use.
  const rows = KP_SCHEMA.parse(kpResult.value);
  const latest = rows[rows.length - 1];
  const kp = latest?.Kp ?? null;
  const storm = stormLevel(kp);

  const flare =
    flareResult.status === "fulfilled"
      ? (FLARE_SCHEMA.safeParse(flareResult.value).data?.[0] ?? null)
      : null;

  const latitude = kp === null ? 67 : Math.max(45, 67 - kp * 2.5);
  const ring = (lat: number): [number, number][] =>
    Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat]);

  const shared = {
    layer: "space_weather",
    kp,
    stormLevel: storm.level,
    at: latest?.time_tag ?? null,
    flareClass: flare?.current_class ?? flare?.max_class ?? null,
    colour: storm.colour,
  };

  return {
    type: "FeatureCollection",
    features: [
      line(ring(latitude), {
        ...shared,
        id: "aurora-north",
        label: `Planetary K-index ${kp ?? "?"} — ${storm.level}`,
      }),
      line(ring(-latitude), {
        ...shared,
        id: "aurora-south",
        label: `Planetary K-index ${kp ?? "?"} — ${storm.level}`,
      }),
    ],
    meta: {
      kp,
      stormLevel: storm.level,
      flareClass: shared.flareClass,
      at: shared.at,
    },
  };
}

// ── Aurora forecast ────────────────────────────────────────────────────────

const OVATION_SCHEMA = z.object({
  "Observation Time": z.string().optional(),
  "Forecast Time": z.string().optional(),
  coordinates: z.array(z.tuple([z.number(), z.number(), z.number()])),
});

/**
 * NOAA's OVATION model — the probability of visible aurora on a one-degree
 * grid.
 *
 * The full grid is 65,000 cells, nearly all of them zero. Only cells above a
 * visible threshold are kept, and those are thinned onto a coarser lattice:
 * the result is a band an operator can read at a glance rather than a solid
 * mask over both poles that hides the map underneath it.
 */
export async function aurora(): Promise<FeatureCollection> {
  const parsed = OVATION_SCHEMA.parse(
    await getJson(
      "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json",
      { timeoutMs: 40_000 },
    ),
  );
  const at = parsed["Forecast Time"] ?? parsed["Observation Time"] ?? null;

  const features = parsed.coordinates.flatMap(([lon, lat, value]) => {
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
        colour: "#5ce68a",
      }),
    ];
  });

  const peak = features.reduce(
    (max, f) => Math.max(max, Number(f.properties["probability"] ?? 0)),
    0,
  );

  return {
    type: "FeatureCollection",
    features,
    meta: { at, peakProbability: peak },
  };
}

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getJson } from "../http.js";
import { line, point, usable, type FeatureCollection } from "../types.js";
import { NEWS_FEEDS } from "../data/maritime.js";

/** Layers that are reference data or slow-moving infrastructure. */

// ── Nuclear facilities ─────────────────────────────────────────────────────

const PLANT_SCHEMA = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    country: z.string().nullable(),
    lat: z.number(),
    lon: z.number(),
    capacityMW: z.number().nullable(),
    operator: z.string().nullable(),
    status: z.string(),
    wikidata: z.string(),
  }),
);

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Nuclear power facilities, from Wikidata.
 *
 * Baked into the repository rather than queried live: this changes on a scale
 * of years, and a SPARQL endpoint is not something a map layer should depend
 * on at request time. Each entry keeps its Wikidata identifier so any figure
 * here can be checked against the source.
 *
 * Sites that were only ever proposed are dropped — a map of nuclear
 * infrastructure should show what exists. Decommissioned sites are kept and
 * marked, because the site and its spent fuel are still there.
 */
const PLANTS = (() => {
  // The compiled output sits in dist/, so the data file is resolved relative
  // to this module rather than to the working directory.
  for (const candidate of [
    join(here, "..", "data", "nuclear.json"),
    join(here, "..", "..", "..", "src", "live", "data", "nuclear.json"),
  ]) {
    try {
      return PLANT_SCHEMA.parse(JSON.parse(readFileSync(candidate, "utf8")));
    } catch {
      continue;
    }
  }
  return [];
})();

const OPERATIONAL = new Set(["in use", "in partial operation", "starting up"]);
const BUILDING = new Set(["building or structure under construction"]);

export async function infrastructure(): Promise<FeatureCollection> {
  const features = PLANTS.flatMap((plant) => {
    if (plant.status.startsWith("proposed") || plant.status === "project") return [];
    if (!usable(plant.lon, plant.lat)) return [];

    const status = OPERATIONAL.has(plant.status)
      ? "Operational"
      : BUILDING.has(plant.status)
        ? "Under construction"
        : plant.status === "decommissioned" || plant.status === "nuclear decommissioning"
          ? "Decommissioned"
          : "Status unrecorded";

    return [
      point(plant.lon, plant.lat, {
        layer: "infrastructure",
        id: plant.id,
        label: plant.name,
        country: plant.country,
        capacityMW: plant.capacityMW,
        operator: plant.operator,
        status,
        url: `https://www.wikidata.org/wiki/${plant.wikidata}`,
        colour:
          status === "Operational"
            ? "#35c46a"
            : status === "Under construction"
              ? "#ffd60a"
              : "#8e8e93",
      }),
    ];
  });

  return {
    type: "FeatureCollection",
    features,
    meta: { source: "Wikidata", facilities: features.length },
  };
}

// ── Submarine cables ───────────────────────────────────────────────────────

const CABLE_SCHEMA = z.object({
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
          coordinates: z.unknown(),
        }),
      }),
    )
    .default([]),
});

/**
 * The physical internet.
 *
 * Cables do not move, so this is cached for a day — the payload is around
 * 700 KB and refetching it on a timer would be pure waste. Landing points are
 * deliberately left out: they roughly double the weight for a set of dots that
 * sit on the ends of lines already drawn.
 */
export async function cables(): Promise<FeatureCollection> {
  const parsed = CABLE_SCHEMA.parse(
    await getJson(
      "https://www.submarinecablemap.com/api/v3/cable/cable-geo.json",
      { timeoutMs: 60_000 },
    ),
  );

  return {
    type: "FeatureCollection",
    features: parsed.features.flatMap((feature) => {
      const raw = feature.geometry.coordinates;
      if (!Array.isArray(raw)) return [];

      // MultiLineString, mostly — one cable is several segments where it
      // crosses the antimeridian.
      const segments: [number, number][][] =
        Array.isArray(raw[0]) && Array.isArray((raw[0] as unknown[])[0])
          ? (raw as [number, number][][])
          : [raw as [number, number][]];

      return segments.map((coordinates, index) =>
        line(coordinates, {
          layer: "cables",
          id: `${feature.properties.id ?? feature.properties.name ?? "cable"}-${index}`,
          label: feature.properties.name ?? "Submarine cable",
          colour: feature.properties.color ?? "#4a9eff",
        }),
      );
    }),
    meta: { source: "TeleGeography Submarine Cable Map" },
  };
}

// ── Live news ──────────────────────────────────────────────────────────────

export async function liveNews(): Promise<FeatureCollection> {
  return {
    type: "FeatureCollection",
    features: NEWS_FEEDS.map((feed) =>
      point(feed.lon, feed.lat, {
        layer: "live_news",
        id: feed.id,
        label: feed.name,
        city: feed.city,
        country: feed.country,
        language: feed.language,
        category: feed.category,
        url: feed.url,
        colour: "#ffd60a",
      }),
    ),
    meta: {
      note: "Continuous news broadcasts, placed at the newsroom that produces them. A curated set — no public API lists these.",
    },
  };
}

// ── GDELT ──────────────────────────────────────────────────────────────────

const GDELT_SCHEMA = z.object({
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
            count: z.union([z.number(), z.string()]).optional(),
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
 * GDELT's geocoded news coverage, by theme.
 *
 * Plain HTTP, deliberately: api.gdeltproject.org does not answer on 443 at
 * all — the connection times out rather than being refused, which reads as a
 * dead feed rather than a wrong scheme. Nothing authenticates this request and
 * no subject data is in it, and it is fetched from the API process, so no page
 * is downgraded to mixed content.
 *
 * One query per theme rather than one broad query: GDELT scores relevance per
 * query, so a catch-all returns whatever is loudest globally rather than the
 * categories an operator watches.
 */
const THEMES = [
  { theme: "ARMEDCONFLICT", label: "Armed conflict", colour: "#ff3b52" },
  { theme: "PROTEST", label: "Protest", colour: "#ff9f0a" },
  { theme: "TERROR", label: "Terrorism", colour: "#e0173a" },
  { theme: "REFUGEES", label: "Displacement", colour: "#c8b0ff" },
  { theme: "NATURAL_DISASTER", label: "Disaster", colour: "#4fc3f7" },
  { theme: "CYBER_ATTACK", label: "Cyber", colour: "#30d0c0" },
];

const PER_THEME = 250;

export async function gdeltEvents(): Promise<FeatureCollection> {
  const seen = new Set<string>();
  const settled = await Promise.allSettled(
    THEMES.map(async ({ theme, label, colour }) => {
      const parsed = GDELT_SCHEMA.parse(
        await getJson(
          `http://api.gdeltproject.org/api/v1/gkg_geojson?QUERY=${theme}&TIMESPAN=180`,
          { timeoutMs: 40_000 },
        ),
      );

      return parsed.features.slice(0, PER_THEME).flatMap((feature) => {
        const [lon, lat] = feature.geometry?.coordinates ?? [];
        if (!usable(lon, lat)) return [];

        const url = feature.properties.url ?? "";
        if (url.length > 0) {
          if (seen.has(url)) return [];
          seen.add(url);
        }

        return [
          point(lon, lat as number, {
            layer: "gdelt_events",
            id: url.length > 0 ? url : `${lon},${lat}`,
            label: feature.properties.name ?? label,
            theme: label,
            tone: feature.properties.urltone ?? null,
            at: feature.properties.urlpubtimedate ?? null,
            url: url.length > 0 ? url : null,
            colour,
          }),
        ];
      });
    }),
  );

  const features = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (features.length === 0) throw new Error("GDELT returned nothing for any theme");

  return {
    type: "FeatureCollection",
    features,
    meta: { themes: THEMES.map((t) => t.label) },
  };
}

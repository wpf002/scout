import { z } from "zod";
import { merge, getJson } from "../http.js";
import { point, usable, type Feature, type FeatureCollection } from "../types.js";
import { CHOKEPOINTS, PORTS } from "../data/maritime.js";

/**
 * The maritime picture: live vessels where they can be had, plus the ports and
 * chokepoints that make the vessel positions mean something.
 *
 * Live AIS without a key is regional, not global. National authorities publish
 * their own waters and nobody publishes the world for free. Rather than draw a
 * near-empty ocean and let it read as "no shipping", the layer always carries
 * the ports and chokepoints — which are the part of the maritime picture that
 * is actually global — and adds live vessels wherever a national feed covers.
 *
 * Each vessel says which authority saw it, so coverage is legible from the map
 * instead of having to be assumed.
 */

// ── Finland ────────────────────────────────────────────────────────────────

const DIGITRAFFIC_SCHEMA = z.object({
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
            timestampExternal: z.number().optional(),
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
 * Digitraffic answers 406 without gzip regardless of the Accept header, and
 * asks callers to identify themselves. Both are easy to miss and both look
 * like a dead feed.
 */
async function finland(): Promise<Feature[]> {
  const parsed = DIGITRAFFIC_SCHEMA.parse(
    await getJson("https://meri.digitraffic.fi/api/ais/v1/locations", {
      headers: {
        "accept-encoding": "gzip",
        "digitraffic-user": "Scout-OSINT/0.1",
      },
      timeoutMs: 30_000,
    }),
  );

  return parsed.features.flatMap((feature) => {
    const [lon, lat] = feature.geometry?.coordinates ?? [];
    if (!usable(lon, lat)) return [];
    const mmsi = feature.mmsi ?? feature.properties.mmsi ?? null;

    return [
      point(lon, lat as number, {
        layer: "maritime",
        role: "vessel",
        id: mmsi === null ? `${lon},${lat}` : `mmsi-${mmsi}`,
        label: mmsi === null ? "Vessel" : `MMSI ${mmsi}`,
        mmsi,
        speedKn: feature.properties.sog ?? null,
        heading: feature.properties.heading ?? feature.properties.cog ?? 0,
        courseOverGround: feature.properties.cog ?? null,
        authority: "Fintraffic (Finland)",
        colour: "#30d0c0",
      }),
    ];
  });
}

// ── Norway ─────────────────────────────────────────────────────────────────

const BARENTSWATCH_SCHEMA = z.object({
  features: z
    .array(
      z.object({
        properties: z.record(z.string(), z.unknown()).default({}),
        geometry: z
          .object({ coordinates: z.array(z.number()) })
          .nullable()
          .default(null),
      }),
    )
    .default([]),
});

async function norway(): Promise<Feature[]> {
  const parsed = BARENTSWATCH_SCHEMA.parse(
    await getJson(
      "https://kystdatahuset.no/ws/geo/ais/positions/live",
      { timeoutMs: 25_000 },
    ),
  );

  return parsed.features.flatMap((feature) => {
    const [lon, lat] = feature.geometry?.coordinates ?? [];
    if (!usable(lon, lat)) return [];
    const p = feature.properties;
    const mmsi = typeof p["mmsi"] === "number" ? p["mmsi"] : null;

    return [
      point(lon, lat as number, {
        layer: "maritime",
        role: "vessel",
        id: mmsi === null ? `no-${lon},${lat}` : `mmsi-${mmsi}`,
        label: typeof p["name"] === "string" && p["name"].length > 0 ? p["name"] : `MMSI ${mmsi ?? "?"}`,
        mmsi,
        speedKn: typeof p["sog"] === "number" ? p["sog"] : null,
        heading: typeof p["cog"] === "number" ? p["cog"] : 0,
        authority: "Kystverket (Norway)",
        colour: "#30d0c0",
      }),
    ];
  });
}

// ── Reference geography ────────────────────────────────────────────────────

function congestion(vesselsNearby: number): string {
  if (vesselsNearby === 0) return "No live coverage";
  if (vesselsNearby > 60) return "Heavy";
  if (vesselsNearby > 20) return "Moderate";
  return "Light";
}

/** Rough degrees-per-kilometre at the equator, good enough to count nearby. */
const NEAR_DEGREES = 0.55;

function referenceFeatures(vessels: Feature[]): Feature[] {
  const positions = vessels.map(
    (v) => v.geometry.coordinates as [number, number],
  );

  const nearby = (lon: number, lat: number) =>
    positions.filter(
      ([vlon, vlat]) =>
        Math.abs(vlon - lon) < NEAR_DEGREES && Math.abs(vlat - lat) < NEAR_DEGREES,
    ).length;

  const ports = PORTS.map((port) => {
    const live = nearby(port.lon, port.lat);
    return point(port.lon, port.lat, {
      layer: "maritime",
      role: "port",
      id: `port-${port.rank}`,
      label: port.name,
      country: port.country,
      rank: port.rank,
      throughput: `${port.teuMillions.toFixed(1)}M TEU (2023)`,
      liveVessels: live,
      congestion: congestion(live),
      colour: "#5ac8fa",
    });
  });

  const chokepoints = CHOKEPOINTS.map((cp) =>
    point(cp.lon, cp.lat, {
      layer: "maritime",
      role: "chokepoint",
      id: `chokepoint-${cp.name.toLowerCase().replace(/[^a-z]+/g, "-")}`,
      label: cp.name,
      oilTransit:
        cp.oilTransitMbd === null
          ? null
          : `${cp.oilTransitMbd} million barrels per day`,
      note: cp.note,
      liveVessels: nearby(cp.lon, cp.lat),
      colour: "#ff9f0a",
    }),
  );

  return [...ports, ...chokepoints];
}

export async function maritime(): Promise<FeatureCollection> {
  // A failing AIS feed must not cost the ports and chokepoints, which are the
  // globally meaningful part of this layer.
  let vessels: Feature[] = [];
  let authorities = 0;
  try {
    const { items } = await merge<Feature>([finland, norway]);
    vessels = items;
    authorities = new Set(items.map((v) => v.properties["authority"])).size;
  } catch {
    vessels = [];
  }

  return {
    type: "FeatureCollection",
    features: [...referenceFeatures(vessels), ...vessels],
    meta: {
      vessels: vessels.length,
      ports: PORTS.length,
      chokepoints: CHOKEPOINTS.length,
      authorities,
      note:
        vessels.length === 0
          ? "No national AIS feed answered. Ports and chokepoints are reference geography and are always shown."
          : "Live AIS covers the waters of the authorities listed on each vessel, not the world.",
    },
  };
}

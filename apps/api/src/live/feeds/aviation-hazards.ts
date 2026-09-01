import { z } from "zod";
import { getJson } from "../http.js";
import { usable, type Feature, type FeatureCollection } from "../types.js";

/**
 * SIGMETs — the polygons that say where the air is dangerous, and why.
 *
 * These belong under Scout's four tiers of aircraft: an operator looking at
 * traffic diverting around something wants to see the something. Volcanic ash,
 * severe turbulence, thunderstorms, mountain wave, icing and tropical cyclone,
 * each with the flight levels it applies between.
 *
 * From the US Aviation Weather Center, which publishes both the international
 * set and the US domestic one. Public domain, no key.
 */

const AWC = "https://aviationweather.gov/api/data";

/**
 * Coordinates arrive in two shapes.
 *
 * Almost every record uses `{lat, lon}` objects, and a small number use
 * `[lat, lon]` pairs — one in a hundred and fifty on the day this was written.
 * Accepting only the common shape is not a cosmetic bug: parsing the whole
 * array at once meant that single record failed the parse and took all 150
 * others with it, so the layer showed only the US domestic feed and looked
 * like it was working.
 *
 * Hence both shapes below, and hence the per-record parse further down.
 */
const COORD_SCHEMA = z.union([
  z.object({ lat: z.number(), lon: z.number() }),
  // Positional, latitude first — the reverse of GeoJSON, which is exactly the
  // kind of thing that puts a polygon in the wrong hemisphere.
  z.tuple([z.number(), z.number()]).transform(([lat, lon]) => ({ lat, lon })),
]);

const SIGMET_RECORD = z.object({
    icaoId: z.string().nullable().optional(),
    firId: z.string().nullable().optional(),
    firName: z.string().nullable().optional(),
    hazard: z.string().nullable().optional(),
    qualifier: z.string().nullable().optional(),
    base: z.number().nullable().optional(),
    top: z.number().nullable().optional(),
    geom: z.string().nullable().optional(),
    validTimeFrom: z.number().nullable().optional(),
    validTimeTo: z.number().nullable().optional(),
    seriesId: z.string().nullable().optional(),
    rawSigmet: z.string().nullable().optional(),
    coords: z.array(COORD_SCHEMA).nullable().optional(),
});

/** The hazard codes, spelled out. An operator should not have to decode "MTW". */
const HAZARD: Record<string, { name: string; colour: string }> = {
  TS: { name: "Thunderstorms", colour: "#ff9f0a" },
  TURB: { name: "Severe turbulence", colour: "#ffd60a" },
  ICE: { name: "Icing", colour: "#5ac8fa" },
  MTW: { name: "Mountain wave", colour: "#c8b0ff" },
  VA: { name: "Volcanic ash", colour: "#ff3b52" },
  TC: { name: "Tropical cyclone", colour: "#e0173a" },
  DS: { name: "Duststorm", colour: "#d2a679" },
  SS: { name: "Sandstorm", colour: "#d2a679" },
};

/** Flight level to a phrase a reader can hold. FL230 is 23,000 feet. */
function band(base: number | null | undefined, top: number | null | undefined): string | null {
  if (base == null && top == null) return null;
  const asFeet = (v: number) => `${v.toLocaleString()} ft`;
  if (base != null && top != null) return `${asFeet(base)} to ${asFeet(top)}`;
  return top != null ? `up to ${asFeet(top)}` : `above ${asFeet(base ?? 0)}`;
}

function toFeature(
  row: z.infer<typeof SIGMET_RECORD>,
  source: string,
): Feature[] {
  const coords = row.coords ?? [];
  // A SIGMET without a boundary cannot be drawn. Several are issued against a
  // named FIR with no geometry at all.
  if (coords.length < 3) return [];

  const ring: [number, number][] = coords
    .filter((c) => usable(c.lon, c.lat))
    .map((c) => [c.lon, c.lat]);
  if (ring.length < 3) return [];

  // A polygon ring has to close; the feed leaves it open.
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first !== undefined && last !== undefined && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push(first);
  }

  const code = row.hazard ?? "";
  const hazard = HAZARD[code] ?? { name: code || "Hazard", colour: "#ff9f0a" };
  const qualifier = row.qualifier === null ? null : row.qualifier;

  return [
    {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {
        layer: "sigmets",
        id: `${row.icaoId ?? row.firId ?? "sigmet"}-${code}-${row.seriesId ?? ""}-${row.validTimeFrom ?? ""}`,
        label: `${hazard.name}${qualifier !== null && qualifier !== undefined ? ` (${qualifier})` : ""} — ${row.firName ?? row.firId ?? "airspace"}`,
        hazard: hazard.name,
        hazardCode: code,
        qualifier,
        altitude: band(row.base, row.top),
        fir: row.firName ?? row.firId ?? null,
        validFrom: row.validTimeFrom == null ? null : row.validTimeFrom * 1000,
        validTo: row.validTimeTo == null ? null : row.validTimeTo * 1000,
        // The original text, so the reading can always be checked against
        // what the meteorological office actually issued.
        raw: row.rawSigmet ?? null,
        source,
        colour: hazard.colour,
      },
    },
  ];
}

export async function sigmets(): Promise<FeatureCollection> {
  const [international, domestic] = await Promise.allSettled([
    getJson(`${AWC}/isigmet?format=json`, { timeoutMs: 30_000 }),
    getJson(`${AWC}/airsigmet?format=json`, { timeoutMs: 30_000 }),
  ]);

  const now = Date.now() / 1000;
  const collected: Feature[] = [];
  let skipped = 0;

  for (const [result, source] of [
    [international, "Aviation Weather Center (international)"],
    [domestic, "Aviation Weather Center (US domestic)"],
  ] as const) {
    if (result.status !== "fulfilled") continue;
    if (!Array.isArray(result.value)) continue;

    /*
     * Parsed one record at a time, deliberately.
     *
     * Validating the array as a whole means a single malformed record
     * discards every other one — which is precisely what happened here, and
     * it fails silently: the layer draws the other feed's records and looks
     * healthy. One bad SIGMET should cost one SIGMET.
     */
    for (const raw of result.value) {
      const parsed = SIGMET_RECORD.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const row = parsed.data;
      // An expired SIGMET is not a hazard. The feed carries recent history.
      if (row.validTimeTo != null && row.validTimeTo < now) continue;
      collected.push(...toFeature(row, source));
    }
  }

  if (collected.length === 0) {
    throw new Error("no SIGMETs with usable geometry");
  }

  const counts: Record<string, number> = {};
  for (const feature of collected) {
    const hazard = String(feature.properties["hazard"]);
    counts[hazard] = (counts[hazard] ?? 0) + 1;
  }

  return {
    type: "FeatureCollection",
    features: collected,
    meta: {
      byHazard: counts,
      source: "NOAA Aviation Weather Center",
      // Reported rather than swallowed: a rising number here means the feed's
      // shape has moved again.
      unparsed: skipped,
    },
  };
}

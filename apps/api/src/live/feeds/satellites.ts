import * as satellite from "satellite.js";
import { persistent } from "../cache.js";
import { getText } from "../http.js";
import { point, usable, type Feature, type FeatureCollection } from "../types.js";

/**
 * Satellites, propagated rather than fetched.
 *
 * There is no service that publishes live satellite positions — what is
 * published is orbital elements, and the position is computed from them. Every
 * dot on this layer is the output of SGP4 run against a TLE that is at most a
 * few hours old, which is what tracking has always meant.
 *
 * The consequence worth stating: these are *predicted* positions. For a LEO
 * satellite an element set a few hours old is good to a few kilometres, which
 * is far inside the size of the dot. They are not observations.
 */

const CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php";

export type Category =
  | "comms"
  | "military"
  | "navigation"
  | "earth_obs"
  | "science"
  | "other";

interface Group {
  group: string;
  category: Category;
  mission: string;
}

/**
 * CelesTrak's groups, mapped to the categories the map offers.
 *
 * Ordered most specific first: a satellite in several groups takes the first
 * one that claims it, so Starlink lands in comms rather than in whatever
 * broader group also lists it.
 */
const GROUPS: Group[] = [
  { group: "starlink", category: "comms", mission: "Starlink" },
  { group: "oneweb", category: "comms", mission: "OneWeb" },
  { group: "iridium-NEXT", category: "comms", mission: "Iridium NEXT" },
  { group: "intelsat", category: "comms", mission: "Intelsat" },
  { group: "ses", category: "comms", mission: "SES" },
  { group: "geo", category: "comms", mission: "Geostationary" },
  { group: "gps-ops", category: "navigation", mission: "GPS" },
  { group: "glo-ops", category: "navigation", mission: "GLONASS" },
  { group: "galileo", category: "navigation", mission: "Galileo" },
  { group: "beidou", category: "navigation", mission: "BeiDou" },
  { group: "sarsat", category: "navigation", mission: "Search and Rescue" },
  { group: "military", category: "military", mission: "Military" },
  { group: "musson", category: "military", mission: "Russian Navigation" },
  { group: "planet", category: "earth_obs", mission: "Planet Labs" },
  { group: "spire", category: "earth_obs", mission: "Spire" },
  { group: "resource", category: "earth_obs", mission: "Earth Resources" },
  { group: "weather", category: "earth_obs", mission: "Weather" },
  { group: "stations", category: "science", mission: "Space Station" },
  { group: "science", category: "science", mission: "Science" },
  { group: "engineering", category: "science", mission: "Engineering" },
  { group: "cubesat", category: "other", mission: "CubeSat" },
];

export const CATEGORY_COLOUR: Record<Category, string> = {
  comms: "#00e676",
  military: "#ff3b52",
  navigation: "#5ac8fa",
  earth_obs: "#ffd60a",
  science: "#c8b0ff",
  other: "#8e8e93",
};

interface Element {
  name: string;
  noradId: string;
  category: Category;
  mission: string;
  line1: string;
  line2: string;
}

/**
 * CelesTrak updates every two hours and answers 403 to anyone who asks again
 * inside that window — the body says so in words. Re-fetching therefore does
 * not get fresher data, it gets none, so the elements are cached to disk and
 * the disk copy is what a refused refetch falls back to.
 */
const TTL_MS = 2 * 60 * 60_000;
const MAX_STALE_MS = 72 * 60 * 60_000;

async function loadGroup(g: Group): Promise<Element[]> {
  const body = await getText(
    `${CELESTRAK}?GROUP=${g.group}&FORMAT=tle`,
    { timeoutMs: 40_000 },
  );

  // The refusal is a 200-shaped body in some cases and a 403 in others; both
  // start with this sentence rather than with a satellite name.
  if (body.startsWith("GP data has not updated")) {
    throw new Error(`CelesTrak is rate limiting ${g.group}`);
  }

  const lines = body.split("\n").map((l) => l.trimEnd());
  const out: Element[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = (lines[i] ?? "").trim();
    const line1 = lines[i + 1] ?? "";
    const line2 = lines[i + 2] ?? "";
    if (!line1.startsWith("1 ") || !line2.startsWith("2 ")) continue;
    out.push({
      name,
      noradId: line1.slice(2, 7).trim(),
      category: g.category,
      mission: g.mission,
      line1,
      line2,
    });
  }
  return out;
}

async function loadElements(): Promise<Element[]> {
  const byId = new Map<string, Element>();

  /*
   * Cached per group, not as one set.
   *
   * The rate limit is per group per address, so on any given refresh some
   * groups answer and some are refused. Caching the union means one refused
   * group — Starlink, which is two thirds of everything in orbit — takes the
   * whole layer down to a fraction of its size. Caching each group separately
   * means a refusal falls back to that group's own last copy and nothing else
   * notices.
   *
   * Sequential, not parallel. CelesTrak asks for it, and a burst of twenty
   * concurrent requests is exactly what gets an address rate limited.
   */
  let reached = 0;
  for (const g of GROUPS) {
    try {
      const elements = await persistent(
        `celestrak:${g.group}`,
        TTL_MS,
        MAX_STALE_MS,
        () => loadGroup(g),
      );
      reached += 1;
      for (const element of elements) {
        if (!byId.has(element.noradId)) byId.set(element.noradId, element);
      }
    } catch {
      // One group refused with nothing cached is a thinner layer, not a dead
      // one.
    }
  }

  if (byId.size === 0) throw new Error("CelesTrak returned no elements");
  if (reached < GROUPS.length / 2) {
    // Worth knowing: a half-loaded roster looks like a working one.
    // eslint-disable-next-line no-console
    console.warn(`satellites: only ${reached}/${GROUPS.length} groups available`);
  }
  return [...byId.values()];
}

function propagate(element: Element, when: Date): Feature | null {
  try {
    const record = satellite.twoline2satrec(element.line1, element.line2);
    const eci = satellite.propagate(record, when);
    if (eci === null || typeof eci === "boolean" || eci.position === undefined) {
      return null;
    }
    const position = eci.position;
    if (typeof position === "boolean") return null;

    const geodetic = satellite.eciToGeodetic(
      position,
      satellite.gstime(when),
    );
    const lon = satellite.degreesLong(geodetic.longitude);
    const lat = satellite.degreesLat(geodetic.latitude);
    if (!usable(lon, lat)) return null;

    return point(lon, lat, {
      layer: "satellites",
      id: element.noradId,
      label: element.name,
      noradId: element.noradId,
      category: element.category,
      mission: element.mission,
      altitudeKm: Math.round(geodetic.height),
      colour: CATEGORY_COLOUR[element.category],
    });
  } catch {
    // A decayed or malformed element set throws inside SGP4. One satellite.
    return null;
  }
}

export async function satellites(): Promise<FeatureCollection> {
  // Each group is already cached to disk, so this is only the assembly.
  const elements = await loadElements();

  // Propagated fresh on every request — the elements are cached, the positions
  // are not, or the map would show where things were rather than where they
  // are.
  const now = new Date();
  const features = elements.flatMap((element) => {
    const feature = propagate(element, now);
    return feature === null ? [] : [feature];
  });

  const counts: Record<string, number> = {};
  for (const feature of features) {
    const category = String(feature.properties["category"]);
    counts[category] = (counts[category] ?? 0) + 1;
  }

  return {
    type: "FeatureCollection",
    features,
    meta: { categoryCounts: counts, elements: elements.length },
  };
}

/** One category, for the per-category toggles the rail offers. */
export function satellitesIn(category: Category) {
  return async (): Promise<FeatureCollection> => {
    const all = await satellites();
    return {
      type: "FeatureCollection",
      features: all.features.filter(
        (f) => f.properties["category"] === category,
      ),
      meta: all.meta,
    };
  };
}

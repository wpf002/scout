import * as satellite from "satellite.js";
import { persistent } from "../cache.js";
import { getText } from "../http.js";
import { point, usable, type Feature, type FeatureCollection } from "../types.js";

/**
 * Satellites, propagated rather than fetched.
 *
 * No service publishes live satellite positions — what is published is orbital
 * elements, and the position is computed from them. Every dot here is SGP4 run
 * against a TLE that is at most a couple of hours old, which is what tracking
 * has always meant. These are therefore *predicted* positions; for a LEO
 * satellite an element set a few hours old is good to a few kilometres, well
 * inside the size of the dot. They are not observations.
 *
 * Positions come from one request, not twenty.
 *
 * `GROUP=active` is the whole on-orbit catalogue — sixteen thousand objects in
 * a single 2.7 MB file. An earlier version of this fetched twenty-one
 * individual groups to build the same set, which was both slower and
 * genuinely dangerous: CelesTrak answers 403 to a repeat download inside its
 * two-hour window, and firewalls an address that accumulates fifty HTTP errors
 * in that window. Twenty-one requests on a warm cache is twenty-one 403s.
 *
 * The small group files are still fetched, but only as label sets — they say
 * which category a NORAD id belongs to, never where it is.
 */

const CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php";

export type Category =
  | "comms"
  | "military"
  | "navigation"
  | "earth_obs"
  | "science"
  | "other";

export const CATEGORY_COLOUR: Record<Category, string> = {
  comms: "#00e676",
  military: "#ff3b52",
  navigation: "#5ac8fa",
  earth_obs: "#ffd60a",
  science: "#c8b0ff",
  other: "#8e8e93",
};

interface Label {
  group: string;
  category: Category;
  mission: string;
}

/**
 * Label groups, evaluated first match wins.
 *
 * Order matters because these overlap: `gnss` is a superset of the individual
 * constellations, and `sarsat` is mostly GPS and NOAA spacecraft carrying a
 * search-and-rescue payload, so it must not reach the military bucket.
 *
 * `geo` and `visual` are deliberately absent. They are orbit and brightness
 * selections rather than missions — they cut across every category and would
 * corrupt a first-match-wins pass.
 */
const LABEL_GROUPS: Label[] = [
  { group: "stations", category: "science", mission: "Space Station" },
  { group: "science", category: "science", mission: "Science" },
  { group: "engineering", category: "science", mission: "Engineering" },
  { group: "geodetic", category: "science", mission: "Geodetic" },
  { group: "education", category: "science", mission: "Education" },
  { group: "tdrss", category: "science", mission: "Tracking and Data Relay" },
  { group: "gnss", category: "navigation", mission: "Navigation" },
  { group: "gps-ops", category: "navigation", mission: "GPS" },
  { group: "glo-ops", category: "navigation", mission: "GLONASS" },
  { group: "galileo", category: "navigation", mission: "Galileo" },
  { group: "beidou", category: "navigation", mission: "BeiDou" },
  { group: "sbas", category: "navigation", mission: "Satellite Augmentation" },
  { group: "military", category: "military", mission: "Military" },
  { group: "musson", category: "military", mission: "Russian Navigation" },
  { group: "starlink", category: "comms", mission: "Starlink" },
  { group: "oneweb", category: "comms", mission: "OneWeb" },
  { group: "kuiper", category: "comms", mission: "Kuiper" },
  { group: "qianfan", category: "comms", mission: "Qianfan" },
  { group: "iridium-NEXT", category: "comms", mission: "Iridium NEXT" },
  { group: "globalstar", category: "comms", mission: "Globalstar" },
  { group: "orbcomm", category: "comms", mission: "Orbcomm" },
  { group: "ses", category: "comms", mission: "SES" },
  { group: "intelsat", category: "comms", mission: "Intelsat" },
  { group: "eutelsat", category: "comms", mission: "Eutelsat" },
  { group: "telesat", category: "comms", mission: "Telesat" },
  { group: "other-comm", category: "comms", mission: "Communications" },
  { group: "amateur", category: "comms", mission: "Amateur Radio" },
  { group: "resource", category: "earth_obs", mission: "Earth Resources" },
  { group: "weather", category: "earth_obs", mission: "Weather" },
  { group: "planet", category: "earth_obs", mission: "Planet Labs" },
  { group: "spire", category: "earth_obs", mission: "Spire" },
  { group: "sar", category: "earth_obs", mission: "Radar Imaging" },
  { group: "argos", category: "earth_obs", mission: "Argos" },
  { group: "dmc", category: "earth_obs", mission: "Disaster Monitoring" },
  { group: "cubesat", category: "other", mission: "CubeSat" },
];

/**
 * Military and intelligence spacecraft, by name.
 *
 * CelesTrak's `military` group is a trap: it holds twenty-four objects, almost
 * all American, and is not a category of military satellites at all. The
 * recognised programme names below find several hundred — which is a credible
 * layer rather than a rounding error.
 *
 * This is pattern matching on published catalogue names. It finds spacecraft
 * whose *designations* are known military programmes; it does not reveal
 * anything about undisclosed payloads, and nothing here is derived from
 * anything but the public catalogue.
 */
const MILITARY_NAME =
  /^(USA[ -]\d|NROL|KH[- ]|LACROSSE|ONYX|TRUMPET|MENTOR|ORION |MILSTAR|AEHF|WGS |DSCS|SBIRS|DSP |GSSAP|SAR-LUPE|HELIOS |CSO-|OFEQ|TECSAR|YAOGAN|TJS-|GLOBUS|MERIDIAN|RADUGA|STRELA|GONETS|BARS-M|PERSONA|LOTOS|PION|EMKA|NIVELIR|SKYNET|SICRAL|SYRACUSE|ATHENA-FIDUS|COMSATBW|XTAR|UFO |NOSS|INTRUDER)/i;

interface Element {
  name: string;
  noradId: string;
  line1: string;
  line2: string;
}

/**
 * CelesTrak republishes every two hours and refuses a repeat download inside
 * that window with a 403 whose body says so in words. Re-fetching therefore
 * does not get fresher data, it gets none — so elements are cached to disk and
 * the disk copy is what a refused refetch falls back to.
 */
const TTL_MS = 2 * 60 * 60_000;
const MAX_STALE_MS = 7 * 24 * 60 * 60_000;

/** The refusal, and an invalid group name, both arrive as prose. */
function assertElements(body: string, what: string): void {
  if (body.startsWith("GP data has not updated")) {
    throw new Error(`CelesTrak is rate limiting ${what}`);
  }
  // An unknown GROUP is answered with HTTP 200 and an error sentence, not a
  // 4xx. Checking only the status code ingests "Invalid query: ..." as a
  // satellite name.
  if (body.startsWith("Invalid query")) {
    throw new Error(`CelesTrak does not know ${what}`);
  }
}

function parseTle(body: string): Element[] {
  const lines = body.split("\n").map((l) => l.trimEnd());
  const out: Element[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = (lines[i] ?? "").trim();
    const line1 = lines[i + 1] ?? "";
    const line2 = lines[i + 2] ?? "";
    if (!line1.startsWith("1 ") || !line2.startsWith("2 ")) continue;
    out.push({ name, noradId: line1.slice(2, 7).trim(), line1, line2 });
  }
  return out;
}

/**
 * `allowStatus: [403]` is deliberate. CelesTrak's refusal *is* a 403, and its
 * body is the explanation — reading it is how the difference between "asked
 * too soon" and "this group does not exist" is known at all.
 */
async function fetchGroup(group: string, timeoutMs: number): Promise<Element[]> {
  const body = await getText(`${CELESTRAK}?GROUP=${group}&FORMAT=tle`, {
    timeoutMs,
    allowStatus: [403],
  });
  assertElements(body, group);
  const elements = parseTle(body);
  if (elements.length === 0) {
    throw new Error(`CelesTrak returned no elements for ${group}`);
  }
  return elements;
}

async function loadActive(): Promise<Element[]> {
  return fetchGroup("active", 90_000);
}

interface Labelled {
  labels: Record<string, Label>;
  /** The elements those groups carried, kept as a fallback catalogue. */
  elements: Element[];
}

/**
 * NORAD id to category, from the small group files.
 *
 * The elements are kept as well as the labels. They cost nothing extra — they
 * arrived in the same response — and they are what makes the layer survive
 * `active` being refused, because each group is its own rate-limit bucket.
 */
async function loadLabels(): Promise<Labelled> {
  const labels: Record<string, Label> = {};
  const byId = new Map<string, Element>();

  // Sequential and first-match-wins. A burst of concurrent requests is exactly
  // what gets an address rate limited, and a rate-limited address that keeps
  // retrying is what gets it firewalled.
  for (const label of LABEL_GROUPS) {
    try {
      for (const element of await fetchGroup(label.group, 40_000)) {
        labels[element.noradId] ??= label;
        if (!byId.has(element.noradId)) byId.set(element.noradId, element);
      }
    } catch {
      // A group that will not answer costs its label, not the layer. Every
      // satellite still has a position; some just say "other".
    }
  }
  return { labels, elements: [...byId.values()] };
}

interface Catalogued extends Element {
  category: Category;
  mission: string;
  record: satellite.SatRec | null;
}

/**
 * Parsed once, propagated many times.
 *
 * Parsing sixteen thousand TLEs costs about seventy milliseconds and the
 * result does not change until the elements do; propagating them costs about
 * the same and has to happen on every request, or the map would show where
 * things were rather than where they are.
 */
async function loadCatalogue(): Promise<Catalogued[]> {
  const [activeResult, labelled] = await Promise.all([
    persistent("celestrak:active", TTL_MS, MAX_STALE_MS, loadActive).catch(
      () => null,
    ),
    persistent<Labelled>(
      "celestrak:labels",
      24 * 60 * 60_000,
      MAX_STALE_MS,
      loadLabels,
    ).catch((): Labelled => ({ labels: {}, elements: [] })),
  ]);

  /*
   * `active` is one request for the whole catalogue and is what should
   * normally supply positions. When it is refused — asked again inside the
   * two-hour window, with nothing cached — the layer falls back to the
   * elements the label groups already returned. That is a smaller catalogue,
   * a few thousand rather than sixteen, but each group is its own rate-limit
   * bucket, so it is available exactly when `active` is not. It self-heals to
   * the full set on the next successful fetch.
   */
  const elements = activeResult ?? labelled.elements;
  if (elements.length === 0) {
    throw new Error(
      "CelesTrak is rate limiting and nothing is cached. Elements republish every two hours.",
    );
  }

  return elements.map((element) => {
    const label = labelled.labels[element.noradId];
    const military = MILITARY_NAME.test(element.name);

    let record: satellite.SatRec | null = null;
    try {
      record = satellite.twoline2satrec(element.line1, element.line2);
    } catch {
      // A malformed or decayed element set. One satellite.
    }

    return {
      ...element,
      record,
      category: military ? "military" : (label?.category ?? "other"),
      mission: military ? "Military / Intelligence" : (label?.mission ?? "Uncategorised"),
    };
  });
}

function propagate(entry: Catalogued, when: Date, gmst: number): Feature | null {
  if (entry.record === null) return null;
  try {
    const eci = satellite.propagate(entry.record, when);
    if (eci === null || typeof eci === "boolean") return null;
    const position = eci.position;
    if (position === undefined || typeof position === "boolean") return null;

    const geodetic = satellite.eciToGeodetic(position, gmst);
    const lon = satellite.degreesLong(geodetic.longitude);
    const lat = satellite.degreesLat(geodetic.latitude);
    if (!usable(lon, lat)) return null;

    return point(lon, lat, {
      layer: "satellites",
      id: entry.noradId,
      label: entry.name,
      noradId: entry.noradId,
      category: entry.category,
      mission: entry.mission,
      altitudeKm: Math.round(geodetic.height),
      colour: CATEGORY_COLOUR[entry.category],
      url: `https://celestrak.org/satcat/tle.php?CATNR=${entry.noradId}`,
    });
  } catch {
    return null;
  }
}

export async function satellites(): Promise<FeatureCollection> {
  const catalogue = await loadCatalogue();

  const now = new Date();
  // Sidereal time is the same for every satellite in a pass; computing it once
  // rather than sixteen thousand times is most of the cost of this loop.
  const gmst = satellite.gstime(now);

  const features = catalogue.flatMap((entry) => {
    const feature = propagate(entry, now, gmst);
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
    meta: {
      categoryCounts: counts,
      catalogued: catalogue.length,
      // Worth saying: a partial catalogue looks like a working one.
      complete: catalogue.length > 10_000,
    },
  };
}

/** One category, for the per-category toggles the rail offers. */
export function satellitesIn(category: Category) {
  return async (): Promise<FeatureCollection> => {
    const all = await satellites();
    return {
      type: "FeatureCollection",
      features: all.features.filter((f) => f.properties["category"] === category),
      meta: all.meta,
    };
  };
}

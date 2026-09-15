import type { InfraObservation, Subject } from "@scout/sources";
import { asCoordinate, requireSource } from "@scout/sources";

export const placeSource = requireSource("osm-place");

/**
 * What is on the ground at a place.
 *
 * Scout has always been able to draw the world and always been able to
 * investigate a domain, and the two never met: a coordinate could be flown to
 * on the map but could not be the subject of a case, so "what is at this
 * place" was a question the tool could render and not answer.
 *
 * Two upstreams, both keyless:
 *
 *   Nominatim — reverse geocoding. What this place is called and the admin
 *               hierarchy it sits in.
 *   Overpass  — the fixed infrastructure around it. Power, aviation, ports,
 *               military, telecoms, government.
 *
 * Both are volunteer services. The radius is capped, the Overpass query
 * carries its own server-side timeout, and the selector list is deliberately
 * short: an unfiltered radius returns every bench and postbox in it. OSM is
 * crowd-sourced, so an empty answer means nobody has mapped it — never that
 * nothing is there.
 */

const NOMINATIM = "https://nominatim.openstreetmap.org/reverse";
const OVERPASS = "https://overpass-api.de/api/interpreter";

const TIMEOUT_MS = 30_000;
const UA = "Scout-OSINT/0.1 (+authorized-engagement-tooling)";

/** Metres. Wide enough to catch a site's outbuildings, tight enough to stay local. */
const RADIUS_M = 2_000;
const MAX_FEATURES = 120;

/**
 * What is worth asking for, as published OSM tags. This mirrors the AOI
 * board's category list — the same question asked about a point rather than a
 * drawn box, so the two should not disagree about what counts.
 */
const SELECTORS = [
  '["power"~"^(plant|substation|generator)$"]',
  '["aeroway"~"^(aerodrome|helipad|terminal)$"]',
  '["military"]',
  '["man_made"~"^(communications_tower|mast|pipeline|water_tower|storage_tank)$"]',
  '["amenity"~"^(hospital|police|fire_station|prison|courthouse|embassy)$"]',
  '["harbour"]',
  '["landuse"~"^(industrial|military)$"]',
  '["office"="government"]',
  '["telecom"="data_center"]',
];

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Great-circle metres. Good enough at this radius. */
export function metresBetween(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** The tag that says what a feature is, in "key=value" form. */
export function categoryOf(tags: Record<string, string>): string {
  for (const key of [
    "power",
    "aeroway",
    "military",
    "man_made",
    "amenity",
    "harbour",
    "landuse",
    "office",
    "telecom",
  ]) {
    const value = tags[key];
    if (value !== undefined) return value === "yes" ? key : `${key}=${value}`;
  }
  return "feature";
}

export function normalizePlace(
  elements: OverpassElement[],
  origin: { lat: number; lon: number },
  address: string | null,
): InfraObservation[] {
  return elements
    .flatMap((element): InfraObservation[] => {
      const lat = element.lat ?? element.center?.lat;
      const lon = element.lon ?? element.center?.lon;
      if (lat === undefined || lon === undefined) return [];
      const tags = element.tags ?? {};

      return [{
        kind: "place-feature" as const,
        category: categoryOf(tags),
        // An unnamed feature is still a feature. Saying what it is beats
        // dropping it or calling it "(unnamed)".
        name: tags["name"] ?? tags["operator"] ?? categoryOf(tags),
        lat,
        lon,
        distanceM: metresBetween(origin, { lat, lon }),
        osmRef: `${element.type}/${element.id}`,
        address,
      }];
    })
    .sort((a, b) => {
      if (a.kind !== "place-feature" || b.kind !== "place-feature") return 0;
      return a.distanceM - b.distanceM;
    })
    .slice(0, MAX_FEATURES);
}

async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  try {
    const url = `${NOMINATIM}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14`;
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { display_name?: unknown };
    return typeof body.display_name === "string" ? body.display_name : null;
  } catch {
    // The name is context, not the finding. Losing it must not lose the
    // features that were actually asked for.
    return null;
  }
}

export async function fetchPlace(subject: Subject): Promise<InfraObservation[]> {
  if (subject.kind !== "location") return [];
  const point = asCoordinate(subject.value);
  if (point === null) {
    throw new Error("Location must be a coordinate pair, for example 32.9240, -96.7645.");
  }

  const around = `(around:${RADIUS_M},${point.lat},${point.lon})`;
  const query =
    `[out:json][timeout:25];(` +
    SELECTORS.map((selector) => `nwr${selector}${around};`).join("") +
    `);out center tags ${MAX_FEATURES};`;

  const [address, response] = await Promise.all([
    reverseGeocode(point.lat, point.lon),
    fetch(OVERPASS, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": UA,
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  ]);

  if (!response.ok) throw new Error(`Overpass responded ${response.status}`);
  const body = (await response.json()) as { elements?: unknown };
  const elements = Array.isArray(body.elements) ? (body.elements as OverpassElement[]) : [];
  return normalizePlace(elements, point, address);
}

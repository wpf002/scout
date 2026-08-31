/**
 * The shape every live layer is normalised into.
 *
 * One shape rather than sixteen is the whole point of fetching these
 * server-side: the map handles GeoJSON and nothing else, and a feed that
 * changes its mind about field names breaks one adapter rather than the map.
 */

export interface Feature {
  type: "Feature";
  geometry:
    | { type: "Point"; coordinates: [number, number] }
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "Polygon"; coordinates: [number, number][][] };
  properties: Record<string, unknown>;
}

export interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
  /** Set when the layer ran but could not reach its upstream. */
  error?: string;
  /** Free-form per-layer summary the HUD can show without parsing features. */
  meta?: Record<string, unknown>;
}

export const point = (
  lon: number,
  lat: number,
  properties: Record<string, unknown>,
): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties,
});

export const line = (
  coordinates: [number, number][],
  properties: Record<string, unknown>,
): Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates },
  properties,
});

export const empty = (): FeatureCollection => ({
  type: "FeatureCollection",
  features: [],
});

/** A coordinate pair that is actually on Earth. */
export function usable(lon: unknown, lat: unknown): lon is number {
  return (
    typeof lon === "number" &&
    typeof lat === "number" &&
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 90 &&
    // 0,0 is in the Gulf of Guinea and is almost always a missing value that
    // survived as a zero. Dropping it costs nothing and stops the map growing
    // a permanent cluster off Africa.
    !(lon === 0 && lat === 0)
  );
}

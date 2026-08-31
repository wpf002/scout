/**
 * Measurement on a sphere.
 *
 * Everything here works in geographic coordinates rather than projecting
 * first, because the map is a globe and a planar approximation is wrong by a
 * useful amount at exactly the scales an operator cares about — a "50 km"
 * radius drawn flat near the poles is not 50 km.
 */

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

export type Shape = "radius" | "box" | "path";

export interface Point {
  lon: number;
  lat: number;
}

/** Great-circle distance in metres. */
export function distance(a: Point, b: Point): number {
  const φ1 = a.lat * RAD;
  const φ2 = b.lat * RAD;
  const dφ = (b.lat - a.lat) * RAD;
  const dλ = (b.lon - a.lon) * RAD;

  const h =
    Math.sin(dφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Area of a closed ring in square metres, by spherical excess.
 *
 * The sign depends on winding order, so the magnitude is what is returned —
 * an operator drawing a box clockwise and one drawing it anticlockwise are
 * asking the same question.
 */
export function area(ring: Point[]): number {
  if (ring.length < 3) return 0;

  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const current = ring[i];
    const next = ring[(i + 1) % ring.length];
    if (current === undefined || next === undefined) continue;
    total +=
      (next.lon - current.lon) *
      RAD *
      (2 + Math.sin(current.lat * RAD) + Math.sin(next.lat * RAD));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** A circle on the sphere, as a polygon ring. */
export function circle(centre: Point, radiusM: number, steps = 128): Point[] {
  const δ = radiusM / EARTH_RADIUS_M;
  const φ1 = centre.lat * RAD;
  const λ1 = centre.lon * RAD;

  return Array.from({ length: steps + 1 }, (_, index) => {
    const θ = (index / steps) * 2 * Math.PI;
    const φ2 = Math.asin(
      Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
    );
    const λ2 =
      λ1 +
      Math.atan2(
        Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
        Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
      );
    return { lon: ((λ2 / RAD + 540) % 360) - 180, lat: φ2 / RAD };
  });
}

export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  if (metres < 100_000) return `${(metres / 1000).toFixed(2)} km`;
  return `${Math.round(metres / 1000).toLocaleString()} km`;
}

export function formatArea(squareMetres: number): string {
  const km2 = squareMetres / 1_000_000;
  if (km2 < 1) return `${Math.round(squareMetres).toLocaleString()} m²`;
  if (km2 < 1000) return `${km2.toFixed(2)} km²`;
  return `${Math.round(km2).toLocaleString()} km²`;
}

/**
 * Turn the points collected so far into something drawable, plus the reading.
 *
 * A shape mid-draw is still shown. Waiting for a closed polygon before drawing
 * anything means the first click appears to do nothing.
 */
export function build(
  shape: Shape,
  points: Point[],
): { features: GeoJSON.Feature[]; reading: string | null } {
  const vertices: GeoJSON.Feature[] = points.map((p, index) => ({
    type: "Feature",
    properties: { role: "vertex", index },
    geometry: { type: "Point", coordinates: [p.lon, p.lat] },
  }));

  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) {
    return { features: vertices, reading: null };
  }

  if (shape === "radius") {
    if (points.length < 2) {
      return { features: vertices, reading: "Click the edge of the circle." };
    }
    const radius = distance(first, last);
    const ring = circle(first, radius);
    return {
      features: [
        {
          type: "Feature",
          properties: { role: "shape" },
          geometry: {
            type: "Polygon",
            coordinates: [ring.map((p) => [p.lon, p.lat])],
          },
        },
        ...vertices,
      ],
      reading: `r ${formatDistance(radius)} · ${formatArea(Math.PI * radius * radius)}`,
    };
  }

  if (shape === "box") {
    if (points.length < 2) {
      return { features: vertices, reading: "Click the opposite corner." };
    }
    const west = Math.min(first.lon, last.lon);
    const east = Math.max(first.lon, last.lon);
    const south = Math.min(first.lat, last.lat);
    const north = Math.max(first.lat, last.lat);
    const ring: Point[] = [
      { lon: west, lat: south },
      { lon: east, lat: south },
      { lon: east, lat: north },
      { lon: west, lat: north },
      { lon: west, lat: south },
    ];
    return {
      features: [
        {
          type: "Feature",
          properties: { role: "shape" },
          geometry: {
            type: "Polygon",
            coordinates: [ring.map((p) => [p.lon, p.lat])],
          },
        },
        ...vertices,
      ],
      reading: `${formatArea(area(ring))} · ${west.toFixed(3)},${south.toFixed(3)} to ${east.toFixed(3)},${north.toFixed(3)}`,
    };
  }

  if (points.length < 2) {
    return { features: vertices, reading: "Click to add points." };
  }

  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous === undefined || current === undefined) continue;
    total += distance(previous, current);
  }

  return {
    features: [
      {
        type: "Feature",
        properties: { role: "shape" },
        geometry: {
          type: "LineString",
          coordinates: points.map((p) => [p.lon, p.lat]),
        },
      },
      ...vertices,
    ],
    reading: `${formatDistance(total)} over ${points.length - 1} leg${points.length === 2 ? "" : "s"}`,
  };
}

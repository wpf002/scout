import type { Entity, EntityKind, GraphEdge, Observation } from "./v2";

/**
 * Pure helpers behind the investigation console: what to draw on the map at
 * a moment, and where each source actually had data. Kept out of the
 * component so the arithmetic is tested on its own.
 */

export const KIND_COLOUR: Record<EntityKind, string> = {
  PERSON: "#e0a33c",
  ORG: "#5ac8fa",
  VESSEL: "#35c46a",
  AIRCRAFT: "#ff9f0a",
  VEHICLE: "#c9a227",
  ACCOUNT: "#9b6bff",
  LOCATION: "#8e8e93",
  DEVICE: "#ff3b52",
  INFRASTRUCTURE: "#676c80",
};

export interface MapLayer {
  points: GeoJSON.Feature[];
  /** One trace per entity through its positioned observations. */
  lines: GeoJSON.Feature[];
  /** Edges that held at the moment, between the entities' last positions. */
  links: GeoJSON.Feature[];
  /** Grid cells with counts, for a case too big to draw as points. */
  density: GeoJSON.Feature[];
  /** Co-location clusters at the moment, one marker each. */
  clusters: GeoJSON.Feature[];
  selected: string | null;
}

export const EMPTY_LAYER: MapLayer = { points: [], lines: [], links: [], density: [], clusters: [], selected: null };

/** How many observations the console reads as points before it switches to density and a viewport window. */
export const POINT_CAP = 2_000;

export interface Viewport {
  /** west, south, east, north */
  bbox: [number, number, number, number];
  zoom: number;
}

/** A grid cell size for a zoom level: coarse from orbit, fine on a street. About 1 500 cells across the view at most. */
export function cellForZoom(zoom: number): number {
  if (zoom <= 2) return 2;
  if (zoom <= 3) return 1;
  if (zoom <= 4) return 0.5;
  if (zoom <= 5) return 0.25;
  if (zoom <= 6) return 0.1;
  if (zoom <= 7) return 0.05;
  if (zoom <= 8) return 0.02;
  return 0.01;
}

/** The view, widened by `factor` on each side and clamped, so a pan does not immediately leave what was fetched. */
export function padBox(bbox: Viewport["bbox"], factor = 0.5): Viewport["bbox"] {
  const [w, s, e, n] = bbox;
  const dx = (e - w) * factor;
  const dy = (n - s) * factor;
  return [Math.max(-180, w - dx), Math.max(-90, s - dy), Math.min(180, e + dx), Math.min(90, n + dy)];
}

export interface DensityCell {
  lon: number;
  lat: number;
  count: number;
  sources: string[];
  kinds: string[];
  latestObservedAt: string;
}

/** Cells as features. `weight` is the count on a log scale against the densest cell, for size and opacity. */
export function densityLayer(cells: readonly DensityCell[]): GeoJSON.Feature[] {
  const max = Math.max(1, ...cells.map((c) => c.count));
  return cells.map((c) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [c.lon, c.lat] },
    properties: {
      layer: "investigation-density",
      label: `${c.count.toLocaleString("en-US")} observation${c.count === 1 ? "" : "s"}`,
      count: c.count,
      weight: Math.log(c.count + 1) / Math.log(max + 1),
      sources: c.sources.join(", "),
      kinds: c.kinds.join(", "),
      latestObservedAt: c.latestObservedAt,
    },
  }));
}

export interface ClusterSummary {
  id: string;
  entities: Array<{ id: string; kind: EntityKind; label: string }>;
  edges: number;
  evidenceObservationIds: string[];
  centroid: { lon: number; lat: number } | null;
  from: string;
  until: string | null;
}

export function clusterLayer(clusters: readonly ClusterSummary[], selected: string | null): GeoJSON.Feature[] {
  return clusters.flatMap((c) =>
    c.centroid === null
      ? []
      : [
          {
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: [c.centroid.lon, c.centroid.lat] },
            properties: {
              layer: "investigation-cluster",
              label: `${c.entities.length} co-located: ${c.entities.map((e) => e.label).join(", ")}`,
              clusterId: c.id,
              size: c.entities.length,
              entityIds: c.entities.map((e) => e.id).join(","),
              selected: selected !== null && c.entities.some((e) => e.id === selected),
            },
          },
        ],
  );
}

export interface ImageryOverlay {
  id: string;
  url: string;
  /** Top-left, top-right, bottom-right, bottom-left: the order MapLibre's image source wants. */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
}

/** A west,south,east,north box as the four corners an image source takes. */
export function cornersOf(bbox: readonly [number, number, number, number]): ImageryOverlay["coordinates"] {
  const [w, s, e, n] = bbox;
  return [[w, n], [e, n], [e, s], [w, s]];
}

/** "2026-08-14 13:00Z": the reading every timestamp in the console uses. */
export function stamp(at: string | number | Date): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "—" : `${d.toISOString().replace("T", " ").slice(0, 16)}Z`;
}

/** Observation id → the entity it currently belongs to. */
export function memberIndex(entities: readonly Entity[]): Map<string, Entity> {
  const out = new Map<string, Entity>();
  for (const e of entities) for (const m of e.members) out.set(m.observationId, e);
  return out;
}

/**
 * Points for every positioned observation seen by `asOf`, and one trace per
 * entity through its positioned observations in time order. Observations not
 * yet resolved into an entity are still drawn, uncoloured, so what the map
 * shows is what was observed rather than only what was explained.
 */
export function mapLayer(
  observations: readonly Observation[],
  entities: readonly Entity[],
  edges: readonly GraphEdge[],
  asOf: Date,
  selected: string | null,
): MapLayer {
  const byObservation = memberIndex(entities);
  const points: GeoJSON.Feature[] = [];
  const perEntity = new Map<string, { entity: Entity; coords: [number, number, number][] }>();

  for (const o of observations) {
    if (o.position === null || new Date(o.observedAt) > asOf) continue;
    const entity = byObservation.get(o.id) ?? null;
    points.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [o.position.lon, o.position.lat] },
      properties: {
        layer: "investigation",
        label: entity?.canonicalLabel ?? o.sourceId,
        observationId: o.id,
        entityId: entity?.id ?? null,
        kind: entity?.kind ?? null,
        colour: entity === null ? "#676c80" : KIND_COLOUR[entity.kind],
        sourceId: o.sourceId,
        observedAt: o.observedAt,
        selected: entity !== null && entity.id === selected,
      },
    });
    if (entity !== null) {
      const bucket = perEntity.get(entity.id) ?? { entity, coords: [] };
      bucket.coords.push([o.position.lon, o.position.lat, new Date(o.observedAt).getTime()]);
      perEntity.set(entity.id, bucket);
    }
  }

  const lines: GeoJSON.Feature[] = [];
  const last = new Map<string, [number, number]>();
  for (const { entity, coords } of perEntity.values()) {
    coords.sort((a, b) => a[2] - b[2]);
    const end = coords[coords.length - 1];
    if (end !== undefined) last.set(entity.id, [end[0], end[1]]);
    if (coords.length < 2) continue;
    lines.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords.map(([lon, lat]) => [lon, lat]) },
      properties: {
        layer: "investigation-trace",
        label: entity.canonicalLabel,
        entityId: entity.id,
        kind: entity.kind,
        colour: KIND_COLOUR[entity.kind],
        selected: entity.id === selected,
      },
    });
  }

  // An edge is drawn only when both ends had a position by then. One that
  // can't be drawn is still in the panel; the map shows what it can place.
  const links: GeoJSON.Feature[] = [];
  for (const e of edges) {
    const a = last.get(e.fromEntityId);
    const b = last.get(e.toEntityId);
    if (a === undefined || b === undefined) continue;
    links.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [a, b] },
      properties: {
        layer: "investigation-link",
        edgeId: e.id,
        relation: e.relation,
        confidenceBp: e.confidenceBp,
        basis: e.basis,
        selected: e.fromEntityId === selected || e.toEntityId === selected,
      },
    });
  }
  return { points, lines, links, density: [], clusters: [], selected };
}

/** Each entity's last position by `asOf`, for flying the camera to it. */
export function lastPosition(observations: readonly Observation[], entity: Entity, asOf: Date): { lon: number; lat: number; at: string } | null {
  const ids = new Set(entity.members.map((m) => m.observationId));
  let best: { lon: number; lat: number; at: string } | null = null;
  for (const o of observations) {
    if (o.position === null || !ids.has(o.id) || new Date(o.observedAt) > asOf) continue;
    if (best === null || o.observedAt > best.at) best = { lon: o.position.lon, lat: o.position.lat, at: o.observedAt };
  }
  return best;
}

export interface CoverageBand {
  sourceId: string;
  total: number;
  /** Observations per bucket across [from, to]. */
  counts: number[];
}

/**
 * Where each source actually had data. A gap in a band is a gap in the
 * source, drawn as one, so an empty stretch of timeline reads as "nothing
 * was collected" rather than "nothing happened".
 */
export function coverageBands(
  observations: readonly Observation[],
  sourceIds: readonly string[],
  from: Date,
  to: Date,
  buckets = 60,
): CoverageBand[] {
  const span = Math.max(1, to.getTime() - from.getTime());
  const bands = new Map<string, number[]>(sourceIds.map((id) => [id, new Array<number>(buckets).fill(0)]));
  for (const o of observations) {
    const counts = bands.get(o.sourceId);
    if (counts === undefined) continue;
    const t = new Date(o.observedAt).getTime();
    if (t < from.getTime() || t > to.getTime()) continue;
    const index = Math.min(buckets - 1, Math.floor(((t - from.getTime()) / span) * buckets));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return [...bands.entries()].map(([sourceId, counts]) => ({
    sourceId,
    total: counts.reduce((a, b) => a + b, 0),
    counts,
  }));
}

/** The earliest observation, or `fallback` when there are none. */
export function earliest(observations: readonly Observation[], fallback: Date): Date {
  let min = Number.POSITIVE_INFINITY;
  for (const o of observations) min = Math.min(min, new Date(o.observedAt).getTime());
  return Number.isFinite(min) ? new Date(min) : fallback;
}

/**
 * Basis points as a person reads them: "8 000 bp" with its basis beside it.
 * Never the number alone; the rule that made it is part of the reading.
 */
export function describeConfidence(bp: number, basis: string | null | undefined): string {
  const number = `${Math.round(bp).toLocaleString("en-US").replace(/,/g, " ")} bp`;
  if (basis === undefined || basis === null || basis === "") return number;
  const readable = basis
    .replace(/^shared:(\w+)$/, (_, kind: string) => `shared ${kind.toLowerCase().replace("_", " ")}`)
    .replace(/^co-location:(\d+)m\/(\d+)min$/, (_, m: string, min: string) => `within ${m} m and ${min} min`)
    .replace(/^asserted$/, "asserted by an analyst");
  return `${number} · ${readable}`;
}

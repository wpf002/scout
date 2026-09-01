import { prisma } from "@scout/db";
import { badRequest } from "../errors.js";
import { cached } from "../live/cache.js";
import { BY_ID } from "../live/registry.js";
import type { Feature } from "../live/types.js";

/**
 * Watching a place instead of an indicator.
 *
 * The rest of Scout's monitors ask "has anything changed about this domain".
 * A geofence asks "has anything entered this box" — which is the question an
 * operator has about an airbase, a strait or a border, and one an indicator
 * cannot express.
 *
 * It reuses the whole existing machine: the same run records, the same
 * baseline rule, the same added/removed diff, the same acknowledge flow and
 * the same audit trail. What changes is only where the observations come from.
 *
 * The standing constraint holds without needing to be enforced twice: a
 * geofence can only name live map layers, and none of them is person-facing.
 * Aircraft, vessels, fires and incidents are places and platforms. There is no
 * layer here through which a geofence could watch a person.
 */

export interface Area {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** Layers with no fixed position, which a geofence would watch pointlessly. */
const UNWATCHABLE = new Set(["day_night", "terrain_3d", "cctv_previews"]);

export function assertArea(value: unknown): Area {
  const area = value as Partial<Area> | null;
  if (area === null || typeof area !== "object") {
    throw badRequest("An area needs south, west, north and east.");
  }
  const { south, west, north, east } = area;
  for (const bound of [south, west, north, east]) {
    if (typeof bound !== "number" || !Number.isFinite(bound)) {
      throw badRequest("Every bound of an area must be a number.");
    }
  }
  if ((south as number) >= (north as number) || (west as number) >= (east as number)) {
    throw badRequest("The area is inside out.");
  }
  if (Math.abs(north as number) > 90 || Math.abs(south as number) > 90) {
    throw badRequest("Latitudes must be between -90 and 90.");
  }
  return { south, west, north, east } as Area;
}

export function assertWatchableLayers(layerIds: readonly string[]): string[] {
  if (layerIds.length === 0) {
    throw badRequest("A geofence needs at least one layer to watch.");
  }
  for (const layerId of layerIds) {
    if (UNWATCHABLE.has(layerId)) {
      throw badRequest(
        `"${layerId}" has no fixed position and cannot be watched by a geofence.`,
      );
    }
    if (!BY_ID.has(layerId)) {
      throw badRequest(`"${layerId}" is not a live layer.`);
    }
  }
  return [...layerIds];
}

function inside(area: Area, lon: number, lat: number): boolean {
  return lon >= area.west && lon <= area.east && lat >= area.south && lat <= area.north;
}

export interface GeoObservation {
  key: string;
  kind: string;
  detail: Record<string, unknown>;
  layerId: string;
}

/**
 * Everything inside the fence, right now.
 *
 * The layers are read through the same cached loaders the map uses, so a
 * geofence adds no upstream load beyond what a viewer would already cause —
 * a monitor watching aircraft does not fetch aircraft again.
 */
export async function observeArea(
  area: Area,
  layerIds: readonly string[],
): Promise<{ observations: GeoObservation[]; errors: { sourceId: string; message: string }[] }> {
  const observations: GeoObservation[] = [];
  const errors: { sourceId: string; message: string }[] = [];

  for (const layerId of layerIds) {
    const layer = BY_ID.get(layerId);
    if (layer === undefined) continue;

    try {
      const collection = await cached(`layer:${layer.id}`, layer.ttlMs, layer.load);
      for (const feature of collection.features as Feature[]) {
        if (feature.geometry.type !== "Point") continue;
        const [lon, lat] = feature.geometry.coordinates;
        if (typeof lon !== "number" || typeof lat !== "number") continue;
        if (!inside(area, lon, lat)) continue;

        const properties = feature.properties;
        const id = String(properties["id"] ?? `${lon},${lat}`);
        observations.push({
          // Namespaced by layer so an id that repeats across feeds is two
          // observations, not one that flaps between them.
          key: `${layerId}:${id}`,
          kind: layerId,
          layerId,
          detail: {
            label: properties["label"] ?? id,
            layer: layerId,
            lon,
            lat,
            ...properties,
          },
        });
      }
    } catch (error) {
      errors.push({
        sourceId: layerId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { observations, errors };
}

/** A geofence monitor, as stored. */
export function areaOf(monitor: { area: unknown }): Area | null {
  if (monitor.area === null || typeof monitor.area !== "object") return null;
  const record = monitor.area as Record<string, unknown>;
  const { south, west, north, east } = record;
  if (
    typeof south !== "number" ||
    typeof west !== "number" ||
    typeof north !== "number" ||
    typeof east !== "number"
  ) {
    return null;
  }
  return { south, west, north, east };
}

/** Names for the alert feed, so "3 changes" says which fence and which layers. */
export async function describeGeofence(monitorId: string): Promise<string | null> {
  const monitor = await prisma.monitor.findUnique({ where: { id: monitorId } });
  if (monitor === null) return null;
  const area = areaOf(monitor);
  if (area === null) return null;
  return `${monitor.name} — ${monitor.layerIds.join(", ")} inside ${area.south.toFixed(2)},${area.west.toFixed(2)} to ${area.north.toFixed(2)},${area.east.toFixed(2)}`;
}

import { proxy } from "./basemap";

/**
 * Live satellite imagery, from NASA's Global Imagery Browse Services.
 *
 * These are raster overlays rather than data layers: they sit between the
 * basemap and the marks, and they are the one thing on the map that visibly
 * moves on its own — a storm turning over the Atlantic behind the aircraft
 * flying round it.
 *
 * Two behaviours, which cost an afternoon to find and are invisible in the
 * docs.
 *
 * Geostationary imagery — the GOES and Himawari discs — takes the literal
 * string `default` in the time slot and serves the most recent frame, which
 * means no timestamp to compute and no capabilities document to parse.
 *
 * Polar-orbiting daily composites — VIIRS, MODIS — reject `default` with a
 * 404 and need an explicit date. Today's is not published until the passes are
 * processed, so asking for it gets another 404; the most recent complete day
 * is what these request, and the layer says so rather than appearing broken
 * for several hours each morning.
 *
 * Each layer also pins its own matrix set. They are not interchangeable: the
 * wrong level is a 400, and the right one differs per product.
 */

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

export interface ImageryDef {
  id: string;
  name: string;
  /** The GIBS layer identifier. */
  layer: string;
  /** GoogleMapsCompatible level. Wrong one is a 400, and it differs per product. */
  level: number;
  /** Geostationary layers take `default`; daily composites need a date. */
  cadence: "continuous" | "daily";
  maxzoom: number;
  opacity: number;
  description: string;
}

export const IMAGERY: ImageryDef[] = [
  {
    id: "goes_east",
    name: "GOES-East (Americas)",
    layer: "GOES-East_ABI_GeoColor",
    level: 7,
    cadence: "continuous",
    maxzoom: 7,
    opacity: 0.85,
    description:
      "True-colour by day, infrared by night, over the Americas and the Atlantic. Refreshed every few minutes.",
  },
  {
    id: "goes_west",
    name: "GOES-West (Pacific)",
    layer: "GOES-West_ABI_GeoColor",
    level: 7,
    cadence: "continuous",
    maxzoom: 7,
    opacity: 0.85,
    description: "The same product over the Pacific and the eastern approaches to Asia.",
  },
  {
    id: "goes_infrared",
    name: "Cloud-Top Infrared",
    layer: "GOES-East_ABI_Band13_Clean_Infrared",
    level: 6,
    cadence: "continuous",
    maxzoom: 6,
    opacity: 0.75,
    description:
      "Cloud-top temperature. The coldest tops are the tallest storms, which is what makes convection legible at night.",
  },
  {
    id: "goes_airmass",
    name: "Air Mass",
    layer: "GOES-East_ABI_Air_Mass",
    level: 6,
    cadence: "continuous",
    maxzoom: 6,
    opacity: 0.7,
    description:
      "An RGB composite separating dry stratospheric air from moist tropical air — jet streams and cyclogenesis.",
  },
  {
    id: "viirs_truecolor",
    name: "VIIRS True Colour",
    layer: "VIIRS_NOAA20_CorrectedReflectance_TrueColor",
    level: 9,
    cadence: "daily",
    maxzoom: 9,
    opacity: 1,
    description:
      "Global 250 m daily composite from NOAA-20. The most recent complete day, since today's passes are still being processed.",
  },
  {
    id: "modis_truecolor",
    name: "MODIS True Colour",
    layer: "MODIS_Terra_CorrectedReflectance_TrueColor",
    level: 9,
    cadence: "daily",
    maxzoom: 9,
    opacity: 1,
    description: "The Terra equivalent, useful when a VIIRS swath has a gap.",
  },
];

export const IMAGERY_BY_ID = new Map(IMAGERY.map((i) => [i.id, i]));

/**
 * The most recent complete UTC day.
 *
 * Today's composite is not published until its passes are processed, so
 * requesting it returns 404 for several hours each morning — which on a map
 * is indistinguishable from the layer being broken.
 */
export function lastCompleteDay(now: Date = new Date()): string {
  const day = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return day.toISOString().slice(0, 10);
}

export function imageryTiles(def: ImageryDef, now?: Date): string {
  const time = def.cadence === "continuous" ? "default" : lastCompleteDay(now);
  return proxy(
    `${GIBS}/${def.layer}/default/${time}/GoogleMapsCompatible_Level${def.level}/{z}/{y}/{x}.png`,
  );
}

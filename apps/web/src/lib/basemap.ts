import type { StyleSpecification } from "maplibre-gl";

/**
 * Basemaps, built as raster styles rather than fetched as vector styles.
 *
 * The vector route failed in a way worth recording: a hosted style references
 * glyph, sprite and TileJSON URLs on shard hostnames the proxy allowlist did
 * not anticipate, and when any one of them is refused the style never reaches
 * `load`. Nothing throws — the map simply sits black forever with no error.
 *
 * A raster style has one dependency: image tiles. There is no glyph server, no
 * sprite sheet, and no TileJSON indirection, so there is nothing to half-load.
 * The cost is that place labels come from a second raster layer rather than
 * being rendered from data.
 */

/*
 * The upstream URL is encoded so it survives as one query parameter, but the
 * `{z}/{y}/{x}` placeholders are put back verbatim: MapLibre substitutes those
 * by literal text match, and percent-encoded braces sail straight past it. The
 * proxy then receives a real tile URL rather than a request for a tile named
 * "{z}" — which upstream answers with an HTML error page, so the map stays
 * black while every request reports 200.
 */
const proxied = (url: string) =>
  `/api/proxy-tiles?url=${encodeURIComponent(url)
    .replace(/%7B/g, "{")
    .replace(/%7D/g, "}")}`;

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";

const IMAGERY = `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`;
const DARK = `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
const LABELS = `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`;

export type BasemapId = "sat" | "map";

function rasterStyle(base: string, labels: boolean): StyleSpecification {
  return {
    version: 8,
    // Esri's tiles are XYZ with y before x in the path, which the template
    // above already accounts for.
    sources: {
      base: {
        type: "raster",
        tiles: [proxied(base)],
        tileSize: 256,
        maxzoom: 18,
        attribution: "Esri, Maxar, Earthstar Geographics",
      },
      ...(labels
        ? {
            labels: {
              type: "raster" as const,
              tiles: [proxied(LABELS)],
              tileSize: 256,
              maxzoom: 18,
            },
          }
        : {}),
    },
    layers: [
      // Space, not a grey void — the globe reads as a body in it.
      { id: "space", type: "background", paint: { "background-color": "#03030a" } },
      { id: "base", type: "raster", source: "base" },
      ...(labels
        ? [
            {
              id: "labels",
              type: "raster" as const,
              source: "labels",
              paint: { "raster-opacity": 0.85 },
            },
          ]
        : []),
    ],
  } as StyleSpecification;
}

export const BASEMAPS: Record<BasemapId, () => StyleSpecification> = {
  sat: () => rasterStyle(IMAGERY, true),
  map: () => rasterStyle(DARK, true),
};

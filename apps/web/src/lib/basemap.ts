import type { StyleSpecification } from "maplibre-gl";

/**
 * Basemaps, and the terrain source that sits under them.
 *
 * Two styles, built differently on purpose.
 *
 * SAT is a self-authored raster style over Esri imagery. Raster has exactly
 * one dependency — image tiles — so there is nothing to half-load.
 *
 * MAP is CARTO's dark-matter vector style, fetched whole. Vector gives real
 * label placement, roads that stay sharp at every zoom, and a `building` layer
 * that can be extruded. It also has three more things that can fail: glyphs,
 * a sprite sheet, and a TileJSON indirection — and when any of them is refused
 * the style never reaches `load` and nothing throws. The map simply sits black
 * forever. That is why every host it touches has to be in the proxy allowlist,
 * and why SAT is the default.
 */

const proxy = (url: string) =>
  `/api/proxy-tiles?url=${encodeURIComponent(url)
    // MapLibre substitutes `{z}`/`{x}`/`{y}` by literal text match, and
    // percent-encoded braces sail straight past it — the proxy would then be
    // asked for a tile named "{z}", which upstream answers with an HTML error
    // page at HTTP 200 while the map stays black.
    .replace(/%7B/g, "{")
    .replace(/%7D/g, "}")}`;

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const IMAGERY = `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`;
const LABELS = `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`;

export const CARTO_DARK =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/** AWS's open terrain tiles. Terrarium encoding, not Mapbox's. */
export const TERRAIN_TILES =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

export type BasemapId = "sat" | "map";

function satelliteStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      base: {
        type: "raster",
        // Esri's scheme puts y before x in the path, which the template above
        // already accounts for.
        tiles: [proxy(IMAGERY)],
        tileSize: 256,
        maxzoom: 18,
        attribution: "Esri, Maxar, Earthstar Geographics",
      },
      labels: {
        type: "raster",
        tiles: [proxy(LABELS)],
        tileSize: 256,
        maxzoom: 18,
      },
    },
    layers: [
      // Space, not a grey void — the globe reads as a body in it.
      { id: "space", type: "background", paint: { "background-color": "#03030a" } },
      { id: "base", type: "raster", source: "base" },
      {
        id: "labels",
        type: "raster",
        source: "labels",
        paint: { "raster-opacity": 0.85 },
      },
    ],
  };
}

export const BASEMAPS: Record<BasemapId, () => StyleSpecification | string> = {
  sat: satelliteStyle,
  // The whole style is proxied, and every URL inside it is rewritten to go
  // back through the proxy — see rewriteStyle below.
  map: () => proxy(CARTO_DARK),
};

/**
 * Point a fetched vector style back through the proxy.
 *
 * A hosted style is a document full of absolute URLs to other hosts. Loading
 * it directly would have the browser reach CARTO for tiles, sprites and glyphs
 * — which works, and gives up the single-origin property that makes the
 * allowlist worth having. Rewriting them keeps every request on Scout's own
 * origin.
 */
export function rewriteStyle(style: StyleSpecification): StyleSpecification {
  const rewritten: StyleSpecification = {
    ...style,
    glyphs: typeof style.glyphs === "string" ? proxy(style.glyphs) : style.glyphs,
    sprite:
      typeof style.sprite === "string"
        ? proxy(style.sprite)
        : Array.isArray(style.sprite)
          ? style.sprite.map((s) => ({ ...s, url: proxy(s.url) }))
          : style.sprite,
    sources: Object.fromEntries(
      Object.entries(style.sources ?? {}).map(([id, source]) => {
        const s = source as Record<string, unknown>;
        if (typeof s["url"] === "string") {
          return [id, { ...s, url: proxy(s["url"]) }];
        }
        if (Array.isArray(s["tiles"])) {
          return [
            id,
            { ...s, tiles: (s["tiles"] as string[]).map((t) => proxy(t)) },
          ];
        }
        return [id, source];
      }),
    ) as StyleSpecification["sources"],
  };
  return rewritten;
}

export const terrainSource = () => ({
  type: "raster-dem" as const,
  tiles: [proxy(TERRAIN_TILES)],
  tileSize: 256,
  maxzoom: 13,
  // Terrarium, not Mapbox. Reading it as Mapbox's encoding produces terrain
  // that is wrong by kilometres and looks like a rendering bug.
  encoding: "terrarium" as const,
  attribution: "Mapzen, USGS, SRTM",
});

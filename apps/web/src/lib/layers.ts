/**
 * The layer roster.
 *
 * The URL is the source of truth for which layers are on — `?layers=a,b,c` —
 * so a view is a link. That is the whole reason an operator sends someone a
 * map instead of a screenshot, and it means back/forward move between views
 * rather than between pages.
 */

export interface LayerDef {
  id: string;
  name: string;
  /** One or two characters drawn in the rail. */
  glyph: string;
  colour: string;
  /** Live feeds are fetched; the rest are drawn client-side. */
  kind: "feed" | "overlay" | "panel";
  /** How the feed is drawn. Points unless stated. */
  draw?: "point" | "line";
  /** Feeds needing the current viewport rather than the whole world. */
  needsBbox?: boolean;
  description: string;
}

/**
 * Categories group the layers the way an operator reaches for them, and give
 * the rail its badge counts. The reference tool leads with the group and lets
 * the individual feeds sit behind it, which keeps a long roster navigable.
 */
export interface CategoryDef {
  id: string;
  name: string;
  glyph: string;
  layerIds: string[];
}

export const CATEGORIES: CategoryDef[] = [
  { id: "aviation", name: "Aviation", glyph: "✈", layerIds: ["flights"] },
  { id: "maritime", name: "Maritime", glyph: "⚓", layerIds: ["vessels"] },
  {
    id: "hazards",
    name: "Natural Hazards",
    glyph: "◎",
    layerIds: ["earthquakes", "global_incidents"],
  },
  { id: "news", name: "News & Events", glyph: "◈", layerIds: ["live_news"] },
  {
    id: "space",
    name: "Space Weather",
    glyph: "☉",
    layerIds: ["space_weather", "aurora"],
  },
  {
    id: "infrastructure",
    name: "Infrastructure",
    glyph: "⌁",
    layerIds: ["cables", "cameras"],
  },
  { id: "osint", name: "Network Intel", glyph: "⌗", layerIds: ["osint"] },
  { id: "display", name: "Display", glyph: "◐", layerIds: ["day_night"] },
];

export const LAYERS: LayerDef[] = [
  {
    id: "flights",
    name: "Air Traffic",
    glyph: "✈",
    colour: "#5ac8fa",
    kind: "feed",
    needsBbox: true,
    description: "Live aircraft positions in view, from OpenSky.",
  },
  {
    id: "earthquakes",
    name: "Earthquakes",
    glyph: "◎",
    colour: "#ff9f0a",
    kind: "feed",
    description: "Seismic events in the last 24 hours, from USGS.",
  },
  {
    id: "global_incidents",
    name: "Global Incidents",
    glyph: "▲",
    colour: "#ff3b52",
    kind: "feed",
    description: "Open natural events — fires, storms, floods — from NASA EONET.",
  },
  {
    id: "space_weather",
    name: "Space Weather",
    glyph: "☀",
    colour: "#9b6bff",
    kind: "feed",
    draw: "line",
    description: "Planetary K-index and the approximate auroral bands, from NOAA.",
  },
  {
    id: "day_night",
    name: "Day / Night",
    glyph: "◐",
    colour: "#8e8e93",
    kind: "overlay",
    description: "The solar terminator, computed in the browser.",
  },
  {
    id: "vessels",
    name: "Vessel Traffic",
    glyph: "⚓",
    colour: "#30d0c0",
    kind: "feed",
    description:
      "Live AIS positions in Finnish waters and the northern Baltic, from Digitraffic — the one authority publishing AIS without a key.",
  },
  {
    id: "live_news",
    name: "Live News",
    glyph: "◈",
    colour: "#ffd60a",
    kind: "feed",
    description:
      "Geocoded news on protest, armed conflict and disaster, from GDELT.",
  },
  {
    id: "aurora",
    name: "Aurora Forecast",
    glyph: "≋",
    colour: "#5ce68a",
    kind: "feed",
    description: "Probability of visible aurora, from NOAA's OVATION model.",
  },
  {
    id: "cameras",
    name: "Traffic Cameras",
    glyph: "▣",
    colour: "#c8b0ff",
    kind: "feed",
    description: "Public transport-authority camera positions in NYC and London.",
  },
  {
    id: "cables",
    name: "Submarine Cables",
    glyph: "⌁",
    colour: "#4a9eff",
    kind: "feed",
    draw: "line",
    description: "The submarine fibre that carries the internet between continents.",
  },
  {
    id: "osint",
    name: "OSINT Search",
    glyph: "⌕",
    colour: "#35c46a",
    kind: "panel",
    description: "Scout's indicator search. Located hosts are plotted on the map.",
  },
];

export const LAYER_BY_ID = new Map(LAYERS.map((layer) => [layer.id, layer]));

/** Layers on by default when the URL says nothing. */
export const DEFAULT_LAYERS = ["earthquakes", "global_incidents", "day_night"];

export function parseLayers(search: string): string[] {
  const params = new URLSearchParams(search);
  const raw = params.get("layers");
  if (raw === null) return DEFAULT_LAYERS;

  // Unknown ids are dropped rather than rejected: a link from a newer build
  // should still open, showing the layers this build understands.
  const wanted = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => LAYER_BY_ID.has(id));

  return wanted;
}

export function layersToSearch(active: string[]): string {
  return active.length === 0 ? "?layers=" : `?layers=${active.join(",")}`;
}

/**
 * The layer roster.
 *
 * The URL is the source of truth for which layers are on — `?layers=a,b,c` —
 * so a view is a link. That is the whole reason an operator sends someone a
 * map instead of a screenshot, and it means back and forward move between
 * views rather than between pages.
 */

export type Draw = "point" | "line" | "glow" | "arc";

export interface LayerDef {
  id: string;
  name: string;
  /** One or two characters drawn in the rail. */
  glyph: string;
  colour: string;
  /** Live feeds are fetched; the rest are drawn client-side. */
  kind: "feed" | "overlay";
  /** How the feed is drawn. Points unless stated. */
  draw?: Draw;
  /** Heavy layers are only drawn in, and fetched for, the current view. */
  heavy?: boolean;
  /**
   * A server capability this layer needs. Layers whose capability is absent
   * are not offered at all — a map switch that can never draw is a dead
   * switch, not an honest one.
   */
  requires?: string;
  /** A modifier on another layer rather than a layer of its own. */
  parent?: string;
  /** Who publishes the data. Shown wherever the layer is, so a reading can be traced. */
  source: string;
  description: string;
}

export interface CategoryDef {
  id: string;
  name: string;
  glyph: string;
  layerIds: string[];
}

/**
 * Categories group the layers the way an operator reaches for them, and give
 * the rail its badge counts.
 */
export const CATEGORIES: CategoryDef[] = [
  {
    id: "aviation",
    name: "Aviation",
    glyph: "✈",
    layerIds: ["flights", "private", "jets", "military"],
  },
  { id: "maritime", name: "Maritime", glyph: "⚓", layerIds: ["maritime"] },
  {
    id: "space",
    name: "Space Tracking",
    glyph: "◇",
    layerIds: [
      "satellites",
      "sat_comms",
      "sat_military",
      "sat_navigation",
      "sat_earth",
      "sat_science",
    ],
  },
  {
    id: "surveillance",
    name: "Surveillance",
    glyph: "▣",
    layerIds: ["cctv", "cctv_previews", "live_news"],
  },
  {
    id: "hazards",
    name: "Natural Hazards",
    glyph: "◎",
    layerIds: ["earthquakes", "fires", "weather"],
  },
  {
    id: "threats",
    name: "Threats & Intel",
    glyph: "⚠",
    layerIds: ["infrastructure", "global_incidents", "gdelt_events"],
  },
  {
    id: "network",
    name: "Network Intel",
    glyph: "⌗",
    layerIds: ["malware", "cyber_attacks", "cf_outages", "cf_attacks"],
  },
  {
    id: "space_weather",
    name: "Space Weather",
    glyph: "☉",
    layerIds: ["space_weather", "aurora"],
  },
  {
    id: "infrastructure",
    name: "Infrastructure",
    glyph: "⌁",
    layerIds: ["cables"],
  },
  {
    id: "display",
    name: "Display",
    glyph: "◐",
    layerIds: ["day_night", "terrain_3d"],
  },
];

export const LAYERS: LayerDef[] = [
  // ── Aviation ────────────────────────────────────────────────────────────
  {
    id: "flights",
    source: "OpenSky and adsb.fi",
    name: "Commercial",
    glyph: "✈",
    colour: "#5ac8fa",
    kind: "feed",
    description:
      "Scheduled airline traffic worldwide, from OpenSky and adsb.fi. Positions are ADS-B, so coverage follows receiver density.",
  },
  {
    id: "private",
    source: "OpenSky and adsb.fi",
    name: "Private",
    glyph: "✈",
    colour: "#ffd60a",
    kind: "feed",
    description:
      "General aviation — anything airborne without an airline callsign or a business-jet type code.",
  },
  {
    id: "jets",
    source: "adsb.fi type designators",
    name: "Private Jets",
    glyph: "✈",
    colour: "#ff9f0a",
    kind: "feed",
    description:
      "Aircraft whose ICAO type designator is a business jet. A track with no type code stays under Private rather than being guessed into this tier.",
  },
  {
    id: "military",
    source: "adsb.fi military feed",
    name: "Military",
    glyph: "✦",
    colour: "#ff3b52",
    kind: "feed",
    description:
      "Aircraft flagged military in the shared ADS-B database, from adsb.fi. Transponder-equipped traffic only.",
  },

  // ── Maritime ────────────────────────────────────────────────────────────
  {
    id: "maritime",
    source: "Kystverket, Fintraffic, EIA, port authorities",
    name: "Maritime / Naval",
    glyph: "⚓",
    colour: "#30d0c0",
    kind: "feed",
    description:
      "The world's forty busiest container ports and ten shipping chokepoints, plus live AIS from the national authorities that publish it. Vessel coverage is regional; ports and chokepoints are global.",
  },

  // ── Space ───────────────────────────────────────────────────────────────
  {
    id: "satellites",
    source: "CelesTrak elements, propagated with SGP4",
    name: "All Satellites",
    glyph: "◇",
    colour: "#8e8e93",
    kind: "feed",
    heavy: true,
    description:
      "Every tracked satellite, propagated from CelesTrak orbital elements. These are computed positions, not observations.",
  },
  {
    id: "sat_comms",
    source: "CelesTrak elements, propagated with SGP4",
    name: "Starlink / Comms",
    glyph: "◇",
    colour: "#00e676",
    kind: "feed",
    heavy: true,
    description: "Starlink, OneWeb, Iridium, Intelsat, SES and the geostationary belt.",
  },
  {
    id: "sat_military",
    source: "CelesTrak elements, propagated with SGP4",
    name: "Military / Intel",
    glyph: "◆",
    colour: "#ff3b52",
    kind: "feed",
    description:
      "Satellites CelesTrak lists under military. Classified payloads are not published anywhere, so this is what is publicly catalogued.",
  },
  {
    id: "sat_navigation",
    source: "CelesTrak elements, propagated with SGP4",
    name: "GPS / Navigation",
    glyph: "◈",
    colour: "#5ac8fa",
    kind: "feed",
    description: "GPS, GLONASS, Galileo, BeiDou and search-and-rescue payloads.",
  },
  {
    id: "sat_earth",
    source: "CelesTrak elements, propagated with SGP4",
    name: "Earth Observation",
    glyph: "◉",
    colour: "#ffd60a",
    kind: "feed",
    description: "Imaging and weather constellations — Planet, Spire, and the civil weather fleet.",
  },
  {
    id: "sat_science",
    source: "CelesTrak elements, propagated with SGP4",
    name: "Stations / Telescopes",
    glyph: "✧",
    colour: "#c8b0ff",
    kind: "feed",
    description: "Crewed stations, observatories and engineering payloads.",
  },

  // ── Surveillance ────────────────────────────────────────────────────────
  {
    id: "cctv",
    source: "Caltrans, DriveBC, 511 Ontario, TfL, NYC DOT, Ottawa, LTA",
    name: "CCTV Cameras",
    glyph: "▣",
    colour: "#c8b0ff",
    kind: "feed",
    heavy: true,
    description:
      "Cameras published by transport authorities and municipalities. Agency feeds only — nothing here comes from scanning for exposed devices.",
  },
  {
    id: "cctv_previews",
    source: "The same agencies, one image each",
    name: "Live Previews",
    glyph: "▤",
    colour: "#c8b0ff",
    kind: "overlay",
    parent: "cctv",
    description:
      "Show the current still from each camera in view. Off by default — it is one image request per camera.",
  },
  {
    id: "live_news",
    source: "Curated broadcaster list",
    name: "Live News Feeds",
    glyph: "◈",
    colour: "#ffd60a",
    kind: "feed",
    description:
      "Continuous news broadcasts, placed at the newsroom that produces them.",
  },

  // ── Natural hazards ─────────────────────────────────────────────────────
  {
    id: "earthquakes",
    source: "USGS",
    name: "Earthquakes",
    glyph: "◎",
    colour: "#ff9f0a",
    kind: "feed",
    description: "Seismic events in the last 24 hours, from USGS.",
  },
  {
    id: "fires",
    source: "NASA FIRMS (VIIRS)",
    name: "Active Fires",
    glyph: "▲",
    colour: "#ff6b35",
    kind: "feed",
    heavy: true,
    description:
      "Active fire detections from NASA FIRMS where a key is configured, and named fire events from EONET otherwise.",
  },
  {
    id: "weather",
    source: "NASA EONET and the US National Weather Service",
    name: "Severe Weather",
    glyph: "◍",
    colour: "#4fc3f7",
    kind: "feed",
    description:
      "Named storms from NASA EONET, plus active extreme and severe warnings from the US National Weather Service.",
  },

  // ── Threats and intel ───────────────────────────────────────────────────
  {
    id: "infrastructure",
    name: "Nuclear Facilities",
    source: "Wikidata",
    glyph: "☢",
    colour: "#35c46a",
    kind: "feed",
    description:
      "Nuclear power stations worldwide with reactor capacity, operator and operating status, from Wikidata.",
  },
  {
    id: "global_incidents",
    source: "GDACS",
    name: "Global Incidents",
    glyph: "▲",
    colour: "#ff3b52",
    kind: "feed",
    description:
      "GDACS disaster alerts. The green, orange and red level is GDACS's own published assessment of expected humanitarian impact.",
  },
  {
    id: "gdelt_events",
    source: "GDELT",
    name: "GDELT Events",
    glyph: "◈",
    colour: "#ffd60a",
    kind: "feed",
    heavy: true,
    description:
      "Geocoded news coverage of conflict, protest, terrorism, displacement, disaster and cyber, from GDELT.",
  },

  // ── Network intel ───────────────────────────────────────────────────────
  {
    id: "malware",
    source: "abuse.ch URLhaus",
    name: "Live Malware",
    glyph: "⌗",
    colour: "#ff3b52",
    kind: "feed",
    heavy: true,
    description:
      "Hosts currently serving malware, from abuse.ch URLhaus. Positions are IP geolocation and are approximate — a dot is where an address is registered, not where a machine stands.",
  },
  {
    id: "cyber_attacks",
    source: "abuse.ch ThreatFox and URLhaus",
    name: "Attack Infrastructure",
    glyph: "⌁",
    colour: "#e0173a",
    kind: "feed",
    draw: "arc",
    description:
      "Botnet command-and-control servers linked to payload hosts of the same malware family, both currently observed by abuse.ch. Infrastructure, not observed attacks.",
  },

  // ── Space weather ───────────────────────────────────────────────────────
  {
    id: "space_weather",
    name: "Space Weather",
    source: "NOAA Space Weather Prediction Center",
    glyph: "☉",
    colour: "#9b6bff",
    kind: "feed",
    draw: "line",
    description: "Planetary K-index and the approximate auroral bands, from NOAA.",
  },
  {
    id: "aurora",
    source: "NOAA OVATION model",
    name: "Aurora Forecast",
    glyph: "≋",
    colour: "#5ce68a",
    kind: "feed",
    draw: "glow",
    description: "Probability of visible aurora, from NOAA's OVATION model.",
  },

  // ── Infrastructure ──────────────────────────────────────────────────────
  {
    id: "cables",
    source: "TeleGeography Submarine Cable Map",
    name: "Submarine Cables",
    glyph: "⌁",
    colour: "#4a9eff",
    kind: "feed",
    draw: "line",
    description: "The submarine fibre that carries the internet between continents.",
  },

  // ── Cloudflare Radar ────────────────────────────────────────────────────
  {
    id: "cf_outages",
    source: "Cloudflare Radar",
    name: "Internet Outages",
    glyph: "⊘",
    colour: "#ff3b52",
    kind: "feed",
    requires: "cloudflare",
    description:
      "Internet outages Cloudflare has observed, placed at the country centroid — an outage is national, not a point.",
  },
  {
    id: "cf_attacks",
    source: "Cloudflare Radar",
    name: "Attack Origins",
    glyph: "◬",
    colour: "#ff9f0a",
    kind: "feed",
    requires: "cloudflare",
    description:
      "Share of layer-3 attack traffic by country of origin over the last day, from Cloudflare Radar. A proportion, not a count.",
  },

  // ── Display ─────────────────────────────────────────────────────────────
  {
    id: "day_night",
    source: "Computed in the browser",
    name: "Day / Night Cycle",
    glyph: "◐",
    colour: "#8e8e93",
    kind: "overlay",
    description: "The solar terminator, computed in the browser.",
  },
  {
    id: "terrain_3d",
    source: "AWS terrain tiles",
    name: "3D Terrain",
    glyph: "△",
    colour: "#8e8e93",
    kind: "overlay",
    description: "Elevation from AWS terrain tiles, exaggerated for legibility.",
  },
];

export const LAYER_BY_ID = new Map(LAYERS.map((layer) => [layer.id, layer]));

/** Layers on by default when the URL says nothing. */
export const DEFAULT_LAYERS = [
  "earthquakes",
  "global_incidents",
  "maritime",
  "cables",
  "day_night",
];

export function parseLayers(search: string): string[] {
  const params = new URLSearchParams(search);
  const raw = params.get("layers");
  if (raw === null) return DEFAULT_LAYERS;

  // Unknown ids are dropped rather than rejected: a link from a newer build
  // should still open, showing the layers this build understands.
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => LAYER_BY_ID.has(id));
}

export function layersToSearch(active: string[]): string {
  return active.length === 0 ? "?layers=" : `?layers=${active.join(",")}`;
}

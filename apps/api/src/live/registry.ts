import type { FeatureCollection } from "./types.js";
import { aircraftIn } from "./feeds/aircraft.js";
import { satellites, satellitesIn } from "./feeds/satellites.js";
import { earthquakes, fires, incidents, weather } from "./feeds/hazards.js";
import { attackInfrastructure, malware } from "./feeds/threat.js";
import { cctv } from "./feeds/cctv.js";
import { maritime } from "./feeds/maritime.js";
import { cables, gdeltEvents, infrastructure, liveNews } from "./feeds/reference.js";
import { aurora, spaceWeather } from "./feeds/space.js";

/**
 * Every live layer, and how often it is worth asking again.
 *
 * TTLs come from how fast the underlying thing actually moves, not from a
 * uniform number. Aircraft are continuous and the providers are rate limited.
 * Orbital elements are republished every two hours and the publisher refuses
 * earlier requests. Cables do not move at all.
 */

export interface LayerDef {
  id: string;
  name: string;
  ttlMs: number;
  load: () => Promise<FeatureCollection>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const LAYERS: LayerDef[] = [
  // Aviation — one upstream fetch behind all four, cached together.
  { id: "flights", name: "Commercial", ttlMs: 20_000, load: aircraftIn("commercial") },
  { id: "private", name: "Private", ttlMs: 20_000, load: aircraftIn("private") },
  { id: "jets", name: "Private Jets", ttlMs: 20_000, load: aircraftIn("jet") },
  { id: "military", name: "Military", ttlMs: 20_000, load: aircraftIn("military") },

  // Maritime.
  { id: "maritime", name: "Maritime / Naval", ttlMs: MINUTE, load: maritime },

  // Space — all six share one propagation pass over cached elements.
  { id: "satellites", name: "All Satellites", ttlMs: 30_000, load: satellites },
  { id: "sat_comms", name: "Starlink / Comms", ttlMs: 30_000, load: satellitesIn("comms") },
  { id: "sat_military", name: "Military / Intel", ttlMs: 30_000, load: satellitesIn("military") },
  { id: "sat_navigation", name: "GPS / Navigation", ttlMs: 30_000, load: satellitesIn("navigation") },
  { id: "sat_earth", name: "Earth Observation", ttlMs: 30_000, load: satellitesIn("earth_obs") },
  { id: "sat_science", name: "Stations / Telescopes", ttlMs: 30_000, load: satellitesIn("science") },

  // Surveillance.
  { id: "cctv", name: "CCTV Cameras", ttlMs: 6 * HOUR, load: cctv },
  { id: "live_news", name: "Live News Feeds", ttlMs: 24 * HOUR, load: liveNews },

  // Natural hazards.
  { id: "earthquakes", name: "Earthquakes", ttlMs: MINUTE, load: earthquakes },
  { id: "fires", name: "Active Fires", ttlMs: 15 * MINUTE, load: fires },
  { id: "weather", name: "Severe Weather", ttlMs: 10 * MINUTE, load: weather },

  // Threats and intel.
  { id: "infrastructure", name: "Nuclear Facilities", ttlMs: 24 * HOUR, load: infrastructure },
  { id: "global_incidents", name: "Global Incidents", ttlMs: 10 * MINUTE, load: incidents },
  { id: "gdelt_events", name: "GDELT Events", ttlMs: 10 * MINUTE, load: gdeltEvents },

  // Network intel.
  { id: "malware", name: "Live Malware", ttlMs: 10 * MINUTE, load: malware },
  { id: "cyber_attacks", name: "Attack Infrastructure", ttlMs: 10 * MINUTE, load: attackInfrastructure },

  // Space weather.
  { id: "space_weather", name: "Space Weather", ttlMs: 10 * MINUTE, load: spaceWeather },
  { id: "aurora", name: "Aurora Forecast", ttlMs: 5 * MINUTE, load: aurora },

  // Infrastructure.
  { id: "cables", name: "Submarine Cables", ttlMs: 24 * HOUR, load: cables },
];

export const BY_ID = new Map(LAYERS.map((layer) => [layer.id, layer]));

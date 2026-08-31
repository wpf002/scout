import { z } from "zod";
import { cached } from "../cache.js";
import { getJson, merge } from "../http.js";
import { point, usable, type Feature, type FeatureCollection } from "../types.js";

/**
 * Aircraft, in four tiers.
 *
 * Two providers, because neither is enough alone. OpenSky publishes global
 * positions but no aircraft type, so it can say where everything is and not
 * what any of it is. adsb.fi publishes the ICAO type designator, the
 * registration and a military flag — but only for what its receivers hear, and
 * its whole-world endpoint is a set of radius queries rather than one call.
 *
 * So: OpenSky gives the global picture, adsb.fi's military endpoint gives the
 * military tier outright, and a set of radius queries over the busiest airspace
 * enriches what it can reach with real type codes. A track that both providers
 * see is merged on its ICAO 24-bit address.
 */

const OPENSKY = "https://opensky-network.org/api/states/all";
const ADSBFI = "https://opendata.adsb.fi/api/v2";

export type Tier = "commercial" | "private" | "jet" | "military";

export const TIER_COLOUR: Record<Tier, string> = {
  commercial: "#5ac8fa",
  private: "#ffd60a",
  jet: "#ff9f0a",
  military: "#ff3b52",
};

interface Track {
  hex: string;
  callsign: string;
  lat: number;
  lon: number;
  altitudeM: number | null;
  headingDeg: number;
  speedKts: number | null;
  type: string | null;
  registration: string | null;
  squawk: string | null;
  grounded: boolean;
  tier: Tier;
  origin: string | null;
  source: string;
}

/**
 * ICAO type designators for business jets.
 *
 * The "private jets" tier is only meaningful if it means an actual business
 * jet rather than any aircraft without an airline callsign, so it is keyed off
 * the type designator and nothing else. A track with no type code cannot join
 * this tier — it stays in `private`, which is the honest answer.
 */
const BUSINESS_JETS = new Set([
  // Gulfstream
  "GLF2", "GLF3", "GLF4", "GLF5", "GLF6", "GALX", "G150", "G280", "GA5C", "GA6C", "GA7C",
  // Bombardier
  "CL60", "CL30", "CL35", "CL64", "GL5T", "GLEX", "GL7T", "GL8T",
  "LJ23", "LJ24", "LJ25", "LJ31", "LJ35", "LJ40", "LJ45", "LJ55", "LJ60", "LJ70", "LJ75",
  // Cessna Citation
  "C25A", "C25B", "C25C", "C25M", "C500", "C501", "C510", "C525", "C550", "C551",
  "C560", "C56X", "C650", "C680", "C68A", "C700", "C750",
  // Dassault Falcon
  "FA10", "FA20", "FA50", "FA6X", "FA7X", "FA8X", "F2TH", "F900",
  // Embraer
  "E50P", "E55P", "E545", "E550", "E135", "E35L",
  // Hawker / Beechcraft / Honda / Pilatus turbine singles used as bizjets
  "H25A", "H25B", "H25C", "HDJT", "PC24", "BE40", "PRM1",
  // Others
  "ASTR", "WW24", "SBR1", "SBR2", "MU30", "EA50",
]);

const OPENSKY_SCHEMA = z.object({
  time: z.number().optional(),
  states: z.array(z.array(z.unknown())).nullable().default([]),
});

const ADSB_SCHEMA = z.object({
  ac: z
    .array(
      z.object({
        hex: z.string().optional(),
        flight: z.string().optional(),
        r: z.string().optional(),
        t: z.string().optional(),
        dbFlags: z.number().optional(),
        alt_baro: z.union([z.number(), z.string()]).optional(),
        gs: z.number().optional(),
        true_heading: z.number().optional(),
        track: z.number().optional(),
        squawk: z.string().optional(),
        lat: z.number().optional(),
        lon: z.number().optional(),
      }),
    )
    .default([]),
});

/**
 * An airline callsign is three letters of ICAO airline designator followed by
 * a flight number. A registration used as a callsign is not — which is what
 * separates scheduled traffic from everything else when no type code is
 * available.
 */
const AIRLINE_CALLSIGN = /^[A-Z]{3}\d{1,4}[A-Z]?$/;

function tierFor(
  callsign: string,
  type: string | null,
  military: boolean,
): Tier {
  if (military) return "military";
  if (type !== null && BUSINESS_JETS.has(type)) return "jet";
  return AIRLINE_CALLSIGN.test(callsign) ? "commercial" : "private";
}

async function openSky(): Promise<Track[]> {
  const parsed = OPENSKY_SCHEMA.parse(await getJson(OPENSKY, { timeoutMs: 30_000 }));

  return (parsed.states ?? []).flatMap((state) => {
    // Positional arrays, not objects. 5 is longitude and 6 is latitude —
    // reversed from the usual order, which is the kind of thing that puts an
    // entire fleet in the Indian Ocean if you assume.
    const hex = typeof state[0] === "string" ? state[0].trim() : "";
    const rawCallsign = typeof state[1] === "string" ? state[1].trim() : "";
    const origin = typeof state[2] === "string" ? state[2] : null;
    const lon = state[5];
    const lat = state[6];
    const grounded = state[8] === true;
    const speed = state[9];
    const heading = state[10];
    const geoAltitude = state[13];
    const baroAltitude = state[7];
    const squawk = typeof state[14] === "string" ? state[14] : null;

    if (!usable(lon, lat) || hex.length === 0) return [];

    const altitude = typeof geoAltitude === "number" ? geoAltitude : baroAltitude;
    return [
      {
        hex,
        callsign: rawCallsign,
        lat: lat as number,
        lon,
        altitudeM: typeof altitude === "number" ? Math.round(altitude) : null,
        headingDeg: typeof heading === "number" ? heading : 0,
        // OpenSky reports metres per second; knots is what an operator reads.
        speedKts: typeof speed === "number" ? Math.round(speed * 1.94384) : null,
        type: null,
        registration: null,
        squawk,
        grounded,
        tier: tierFor(rawCallsign, null, false),
        origin,
        source: "OpenSky",
      },
    ];
  });
}

function fromAdsb(
  row: z.infer<typeof ADSB_SCHEMA>["ac"][number],
  forceMilitary: boolean,
): Track[] {
  const hex = (row.hex ?? "").trim();
  if (!usable(row.lon, row.lat) || hex.length === 0) return [];

  const callsign = (row.flight ?? "").trim();
  const type = row.t ?? null;
  // Bit 0 of dbFlags is the military flag in the readsb database these
  // services share.
  const military = forceMilitary || ((row.dbFlags ?? 0) & 1) === 1;
  const grounded = row.alt_baro === "ground";

  return [
    {
      hex,
      callsign,
      lat: row.lat as number,
      lon: row.lon as number,
      altitudeM:
        typeof row.alt_baro === "number"
          ? Math.round(row.alt_baro * 0.3048)
          : null,
      headingDeg: row.true_heading ?? row.track ?? 0,
      speedKts: row.gs === undefined ? null : Math.round(row.gs),
      type,
      registration: row.r ?? null,
      squawk: row.squawk ?? null,
      grounded,
      tier: tierFor(callsign, type, military),
      origin: null,
      source: "adsb.fi",
    },
  ];
}

async function adsbMilitary(): Promise<Track[]> {
  const parsed = ADSB_SCHEMA.parse(await getJson(`${ADSBFI}/mil`));
  return parsed.ac.flatMap((row) => fromAdsb(row, true));
}

/**
 * Radius queries over the airspace that actually carries traffic.
 *
 * These exist to attach type designators to tracks OpenSky can only place, so
 * the private-jet tier means something. They are not an attempt at global
 * coverage — that is OpenSky's job here — and the list is kept short because
 * each one is a request.
 */
const HOTSPOTS: Array<[number, number, string]> = [
  [40.7, -74.0, "US Northeast"],
  [33.9, -118.4, "US West"],
  [41.9, -87.6, "US Midwest"],
  [29.8, -95.4, "US South"],
  [26.1, -80.1, "Florida"],
  [51.5, -0.1, "London"],
  [50.0, 8.6, "Central Europe"],
  [43.0, 2.0, "Western Mediterranean"],
  [55.7, 37.6, "Moscow"],
  [25.3, 55.4, "Gulf"],
  [1.4, 103.8, "Singapore"],
  [35.7, 139.7, "Tokyo"],
  [22.3, 114.2, "Hong Kong"],
  [-33.9, 151.2, "Sydney"],
  [-23.5, -46.6, "Sao Paulo"],
  [19.4, -99.1, "Mexico City"],
  [28.6, 77.2, "Delhi"],
  [-26.2, 28.0, "Johannesburg"],
];

async function adsbHotspots(): Promise<Track[]> {
  const { items } = await merge(
    HOTSPOTS.map(([lat, lon]) => async () => {
      const parsed = z
        .object({ aircraft: ADSB_SCHEMA.shape.ac })
        .or(ADSB_SCHEMA.transform((v) => ({ aircraft: v.ac })))
        .parse(await getJson(`${ADSBFI}/lat/${lat}/lon/${lon}/dist/250`));
      return parsed.aircraft.flatMap((row) => fromAdsb(row, false));
    }),
  );
  return items;
}

async function loadTracks(): Promise<Track[]> {
  const { items, failures } = await merge<Track>([
    openSky,
    adsbMilitary,
    adsbHotspots,
  ]);
  if (items.length === 0) {
    throw new Error(`every aircraft provider failed (${failures})`);
  }

  /*
   * Merge on the ICAO address. adsb.fi wins on the fields it has, because a
   * real type designator beats an inferred tier — that is the entire reason
   * for asking two providers.
   */
  const byHex = new Map<string, Track>();
  for (const track of items) {
    const existing = byHex.get(track.hex);
    if (existing === undefined) {
      byHex.set(track.hex, track);
      continue;
    }
    const richer = track.type !== null ? track : existing;
    const other = track.type !== null ? existing : track;
    byHex.set(track.hex, {
      ...other,
      ...richer,
      callsign: richer.callsign.length > 0 ? richer.callsign : other.callsign,
      origin: richer.origin ?? other.origin,
      // Military is a fact one provider knows and the other does not, so it
      // survives the merge whichever side carried it.
      tier:
        existing.tier === "military" || track.tier === "military"
          ? "military"
          : richer.tier,
    });
  }
  return [...byHex.values()];
}

/** 7500 hijack, 7600 radio failure, 7700 general emergency. */
const EMERGENCY_SQUAWKS: Record<string, string> = {
  "7500": "Unlawful interference",
  "7600": "Radio failure",
  "7700": "General emergency",
};

function toFeature(track: Track): Feature {
  const emergency =
    track.squawk === null ? null : (EMERGENCY_SQUAWKS[track.squawk] ?? null);

  return point(track.lon, track.lat, {
    layer: `aircraft:${track.tier}`,
    id: track.hex,
    label: track.callsign.length > 0 ? track.callsign : (track.registration ?? track.hex.toUpperCase()),
    tier: track.tier,
    icao24: track.hex,
    registration: track.registration,
    aircraftType: track.type,
    altitudeM: track.altitudeM,
    heading: track.headingDeg,
    speedKts: track.speedKts,
    squawk: track.squawk,
    emergency,
    grounded: track.grounded,
    origin: track.origin,
    source: track.source,
    colour: TIER_COLOUR[track.tier],
  });
}

/**
 * One fetch feeds all four tiers. Toggling on Military must not cost another
 * round trip to every provider.
 */
const TTL_MS = 20_000;

export function aircraftIn(tier: Tier) {
  return async (): Promise<FeatureCollection> => {
    const tracks = await cached("aircraft", TTL_MS, loadTracks);
    const mine = tracks.filter((t) => t.tier === tier);
    return {
      type: "FeatureCollection",
      features: mine.map(toFeature),
      meta: {
        tier,
        total: tracks.length,
        emergencies: mine.filter((t) => t.squawk !== null && t.squawk in EMERGENCY_SQUAWKS).length,
      },
    };
  };
}

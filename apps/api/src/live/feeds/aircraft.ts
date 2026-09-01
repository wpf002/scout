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
const ADSBLOL = "https://api.adsb.lol/v2";

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
  /** How stale this position is. Zero means it was just fetched. */
  seenSecondsAgo?: number;
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

/**
 * The two ADS-B services return the same records under different keys —
 * adsb.fi uses `aircraft`, adsb.lol uses `ac`.
 *
 * This is read explicitly rather than as a schema union, and that is not a
 * style preference. A union whose first branch is `{ aircraft: [...] }` with
 * a default silently *succeeds* against `{ ac: [...] }`, producing an empty
 * array and never trying the second branch. The sweep looked like it was
 * running and returned nothing, so the private-jet tier — which exists only
 * because of these type codes — sat at zero.
 */
function aircraftIn_(body: unknown): z.infer<typeof ADSB_SCHEMA>["ac"] {
  const envelope = body as Record<string, unknown> | null;
  const rows = envelope?.["ac"] ?? envelope?.["aircraft"];
  if (!Array.isArray(rows)) return [];
  return ADSB_SCHEMA.parse({ ac: rows }).ac;
}

async function adsbMilitary(): Promise<Track[]> {
  /*
   * adsb.fi first for the military tier because it carries a human-readable
   * model where adsb.lol does not, with adsb.lol as failover — this is the
   * only source for that tier, so it must not share a failure with anything.
   */
  try {
    const body = await getJson(`${ADSBFI}/mil`);
    return aircraftIn_(body).flatMap((row) => fromAdsb(row, true));
  } catch {
    const body = await getJson(`${ADSBLOL}/mil`, { timeoutMs: 30_000 });
    return aircraftIn_(body).flatMap((row) => fromAdsb(row, true));
  }
}

/**
 * Radius sweeps, for the type designators OpenSky does not carry.
 *
 * adsb.lol, not adsb.fi, because the radius limit is the whole story here:
 * adsb.fi rejects anything past 250 nautical miles, while adsb.lol answers a
 * 1000 nm circle — roughly a continent — in one request. Four of those cover
 * most of the world's traffic; forty 250 nm circles would not, and would be
 * forty requests.
 *
 * The two services also use different envelopes for the same data — adsb.fi
 * returns `aircraft`, adsb.lol returns `ac` — which silently zeroes any shared
 * parser that assumes one. Both are accepted below.
 */
const SWEEPS: Array<[number, number, string]> = [
  [39, -96, "North America"],
  [48, 10, "Europe"],
  [25, 55, "Middle East and South Asia"],
  [30, 115, "East Asia"],
  [-10, -55, "South America"],
  [-25, 133, "Australia"],
  [0, 20, "Africa"],
];

/**
 * Rotating, not all at once.
 *
 * adsb.lol answers 429 to a burst, and a rate-limited provider takes the
 * military endpoint with it — that tier then silently empties while the map
 * still shows nine thousand aircraft. Each refresh takes one slice, and the
 * type codes are remembered between rotations so the tiers stay populated.
 */
const SWEEP_BATCH = 3;
let rotation = 0;

/**
 * Each region's last sweep, kept separately.
 *
 * Caching the *pass* rather than the regions made the aircraft count swing
 * between three thousand and six hundred as the rotation moved: whichever
 * three regions had just been swept were the only ones on the map, and the
 * other four vanished until their turn came round. Aircraft blinked in and
 * out of existence every minute.
 *
 * Holding each region's last result means the union is always all seven. A
 * region not swept this pass is up to a rotation old, which is why every
 * track carries the time it was seen — a stale dot in the wrong place is
 * worse than no dot, because it looks current.
 */
const regionSweeps = new Map<string, { at: number; tracks: Track[] }>();

/** A region's tracks are dropped once they are older than a full rotation. */
const SWEEP_MAX_AGE_MS = 4 * 60_000;

async function adsbSweeps(): Promise<Track[]> {
  const start = (rotation * SWEEP_BATCH) % SWEEPS.length;
  rotation += 1;

  const slice = Array.from({ length: SWEEP_BATCH }, (_, i) =>
    SWEEPS[(start + i) % SWEEPS.length],
  ).filter((e): e is [number, number, string] => e !== undefined);

  for (const [lat, lon, name] of slice) {
    try {
      const body = await getJson(`${ADSBLOL}/lat/${lat}/lon/${lon}/dist/1000`, {
        timeoutMs: 45_000,
      });
      regionSweeps.set(name, {
        at: Date.now(),
        tracks: aircraftIn_(body).flatMap((row) => fromAdsb(row, false)),
      });
    } catch {
      // One region keeps its previous result rather than emptying.
    }
    // Sequential and spaced. These are megabyte responses, and a burst of
    // them is what draws a 429.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }

  const now = Date.now();
  const out: Track[] = [];
  for (const [name, entry] of regionSweeps) {
    if (now - entry.at > SWEEP_MAX_AGE_MS) {
      regionSweeps.delete(name);
      continue;
    }
    const seenSecondsAgo = Math.round((now - entry.at) / 1000);
    for (const track of entry.tracks) {
      out.push({ ...track, seenSecondsAgo });
    }
  }
  return out;
}

/**
 * Enrichment is held longer than the positions it decorates.
 *
 * A type designator does not change; a position does. Keeping what the
 * type-bearing providers said lets the private-jet tier stay populated
 * between sweeps instead of collapsing as the rotation moves on.
 */
/** Whether OpenSky answered on the last pass. */
let globalBackfill = true;

const enrichment = new Map<
  string,
  { type: string | null; registration: string | null; military: boolean }
>();

async function loadTracks(): Promise<Track[]> {
  /*
   * Three providers on three cadences, because they cost different amounts.
   *
   * OpenSky is one request for the world and can be asked often. adsb.fi's
   * military endpoint is one request and is the only source for that tier, so
   * it gets its own cache rather than sharing a failure with anything else.
   * The hotspot sweep is several requests and is only enrichment, so it runs
   * slowest.
   */
  const [global, mil, hot] = await Promise.allSettled([
    /*
     * OpenSky is asked once every twenty minutes, and that is a hard
     * constraint rather than a tuning choice.
     *
     * Its anonymous tier is about four hundred credits a day and a whole-world
     * call costs four of them — a hundred calls, total. A twenty-second TTL,
     * which is right for the other providers, is a hundred and eighty calls an
     * hour: it spends the entire day's budget in under forty minutes and then
     * answers 429 until midnight. Twenty minutes is seventy-two calls a day,
     * comfortably inside it.
     *
     * That makes OpenSky a slow global backfill rather than the live picture.
     * The adsb.lol sweeps carry the live picture, and they also carry the type
     * codes OpenSky has never had.
     */
    cached("aircraft:opensky", 20 * 60_000, openSky),
    cached("aircraft:mil", 45_000, adsbMilitary),
    cached("aircraft:sweeps", 60_000, adsbSweeps),
  ]);

  const items: Track[] = [];
  for (const result of [global, mil, hot]) {
    if (result.status === "fulfilled") items.push(...result.value);
  }
  if (items.length === 0) throw new Error("every aircraft provider failed");

  // A thin sky and a refused provider look identical on a map, so the
  // difference is recorded rather than left to be inferred from the count.
  globalBackfill = global.status === "fulfilled";

  // Remember what the type-bearing providers said, so the tiers survive a
  // rotation that has moved on or a provider that is briefly refusing.
  for (const track of items) {
    if (track.type === null && !(track.tier === "military")) continue;
    enrichment.set(track.hex, {
      type: track.type,
      registration: track.registration,
      military: track.tier === "military",
    });
  }

  /*
   * Merge on the ICAO address, preferring the fresher provider for position.
   *
   * OpenSky's snapshot can be twenty minutes old by the time it is used, and
   * an aircraft covers two hundred miles in that time. Where a sweep has seen
   * the same aircraft, its position wins — an out-of-date dot in the right
   * place on the list is worse than no dot, because it looks current.
   */
  const byHex = new Map<string, Track>();
  for (const track of items) {
    const existing = byHex.get(track.hex);
    if (existing === undefined) {
      byHex.set(track.hex, track);
      continue;
    }
    const fresher = track.source === "adsb.fi" ? track : existing;
    const other = track.source === "adsb.fi" ? existing : track;
    byHex.set(track.hex, {
      ...other,
      ...fresher,
      type: fresher.type ?? other.type,
      registration: fresher.registration ?? other.registration,
      origin: fresher.origin ?? other.origin,
    });
  }

  // Apply what is known about each aircraft to whatever position won.
  return [...byHex.values()].map((track) => {
    const known = enrichment.get(track.hex);
    if (known === undefined) return track;
    const type = track.type ?? known.type;
    return {
      ...track,
      type,
      registration: track.registration ?? known.registration,
      tier: tierFor(track.callsign, type, known.military || track.tier === "military"),
    };
  });
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
    seenSecondsAgo: track.seenSecondsAgo ?? 0,
    colour: TIER_COLOUR[track.tier],
  });
}

/**
 * One assembly feeds all four tiers. Toggling on Military must not cost
 * another round trip to every provider — the providers are cached
 * individually inside loadTracks, and this holds the merged result just long
 * enough that four toggled-on tiers are one pass rather than four.
 */
export function aircraftIn(tier: Tier) {
  return async (): Promise<FeatureCollection> => {
    const tracks = await cached("aircraft:merged", 10_000, loadTracks);
    const mine = tracks.filter((t) => t.tier === tier);
    return {
      type: "FeatureCollection",
      features: mine.map(toFeature),
      meta: {
        tier,
        total: tracks.length,
        globalBackfill,
        coverage: globalBackfill
          ? "Global snapshot plus regional sweeps."
          : "Regional sweeps only — OpenSky's anonymous daily budget is spent. It returns at UTC midnight.",
        emergencies: mine.filter((t) => t.squawk !== null && t.squawk in EMERGENCY_SQUAWKS).length,
      },
    };
  };
}

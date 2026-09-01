import { cellToBoundary } from "h3-js";
import { getText } from "../http.js";
import { usable, type Feature, type FeatureCollection } from "../types.js";

/**
 * GNSS interference, from GPSJAM.
 *
 * Aircraft report how good their navigation accuracy is. Where many aircraft
 * in one place report it as degraded, something on the ground is jamming or
 * spoofing GPS. That is what this layer draws: an H3 grid coloured by the
 * fraction of aircraft in each cell reporting bad accuracy.
 *
 * It is the one electronic-warfare signal available from public data, and it
 * comes from the same ADS-B receivers that feed Scout's aircraft layers — so a
 * cell lighting up over the Baltic or the Gulf can be clicked through to the
 * traffic flying it.
 *
 * Two things it is not. It is not a jammer location: the cell is where the
 * *effect* was observed. And a cell with two aircraft, one degraded, is 50%
 * on a sample of two — so cells below a minimum sample are dropped rather than
 * drawn as certainty.
 */

const MIN_AIRCRAFT = 6;

/** Below this fraction the cell is noise rather than signal. */
const MIN_BAD_FRACTION = 0.1;

function utcDay(offsetDays: number): string {
  const day = new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000);
  return day.toISOString().slice(0, 10);
}

/**
 * The file is named for a whole UTC day and is only complete once that day has
 * closed. Today's exists but is partial, so the most recent complete day is
 * what is asked for first — and the layer says which day it is showing,
 * because "yesterday's interference" and "right now" are different claims.
 */
async function loadDay(day: string): Promise<string> {
  return getText(`https://gpsjam.org/data/${day}-h3_4.csv`, {
    // The server always gzips. Without this header the body arrives as
    // binary and parses into nothing — a silent empty layer.
    headers: { "accept-encoding": "gzip" },
    timeoutMs: 60_000,
  });
}

export async function gnssInterference(): Promise<FeatureCollection> {
  let csv: string | null = null;
  let day = "";

  for (const offset of [1, 2]) {
    const candidate = utcDay(offset);
    try {
      csv = await loadDay(candidate);
      day = candidate;
      break;
    } catch {
      continue;
    }
  }
  if (csv === null) throw new Error("GPSJAM did not answer for either recent day");

  const rows = csv.split("\n");
  const header = (rows.shift() ?? "").trim().split(",");
  const iHex = header.indexOf("hex");
  const iGood = header.indexOf("count_good_aircraft");
  const iBad = header.indexOf("count_bad_aircraft");
  if (iHex < 0 || iGood < 0 || iBad < 0) {
    throw new Error("GPSJAM returned an unexpected CSV");
  }

  const features: Feature[] = [];
  for (const row of rows) {
    const cells = row.trim().split(",");
    const hex = cells[iHex];
    if (hex === undefined || hex.length === 0) continue;

    const good = Number(cells[iGood] ?? 0);
    const bad = Number(cells[iBad] ?? 0);
    const total = good + bad;
    if (total < MIN_AIRCRAFT) continue;

    const fraction = bad / total;
    if (fraction < MIN_BAD_FRACTION) continue;

    let ring: [number, number][];
    try {
      // h3-js returns [lat, lon]; GeoJSON wants the reverse, and getting this
      // backwards puts the Baltic in the Indian Ocean.
      ring = cellToBoundary(hex).map(([lat, lon]) => [lon, lat] as [number, number]);
    } catch {
      continue;
    }
    if (ring.length < 3) continue;
    const first = ring[0];
    if (first !== undefined) ring.push(first);
    if (!ring.every(([lon, lat]) => usable(lon, lat))) continue;

    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {
        layer: "gnss_interference",
        id: `gpsjam-${hex}`,
        label: `${Math.round(fraction * 100)}% of aircraft reporting degraded GNSS`,
        degradedFraction: Number(fraction.toFixed(3)),
        aircraftDegraded: bad,
        aircraftTotal: total,
        day,
        note: "Where the effect was observed, not where a transmitter is.",
        source: "GPSJAM (John Wiseman)",
        colour:
          fraction > 0.6 ? "#ff3b52" : fraction > 0.3 ? "#ff9f0a" : "#ffd60a",
      },
    });
  }

  return {
    type: "FeatureCollection",
    features,
    meta: {
      day,
      cells: features.length,
      minimumSample: MIN_AIRCRAFT,
      source: "GPSJAM",
      note: `Aggregated over the UTC day ${day}, not the current hour.`,
    },
  };
}

import { defineCollector, type CollectMeta, type ObservationInput } from "@scout/fusion";
import { aircraftIn, type Tier } from "../../live/feeds/aircraft.js";

/**
 * ADS-B aircraft positions, as v2 observations.
 *
 * The live map already assembles OpenSky, adsb.lol and adsb.fi into one
 * track set (`live/feeds/aircraft.ts`). This collector calls that assembly
 * and writes each track as an observation with provenance, rather than
 * fetching the same upstreams a second time. The upstream that reported each
 * track is kept on the row.
 */

const TIERS: readonly Tier[] = ["commercial", "private", "jet", "military"];

interface AircraftFeature {
  geometry?: { type?: unknown; coordinates?: unknown };
  properties?: Record<string, unknown>;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function normalizeAircraft(raw: unknown, meta: CollectMeta): ObservationInput[] {
  const features = Array.isArray((raw as { features?: unknown })?.features)
    ? ((raw as { features: unknown[] }).features as AircraftFeature[])
    : [];

  const out: ObservationInput[] = [];
  for (const feature of features) {
    const p = feature.properties ?? {};
    const hex = str(p["icao24"])?.toLowerCase() ?? null;
    const coords = feature.geometry?.coordinates;
    if (hex === null || !Array.isArray(coords)) continue;
    const lon = num(coords[0]);
    const lat = num(coords[1]);
    if (lon === null || lat === null) continue;

    // The assembly reports how stale each position is; the observation time
    // is when the aircraft was there, not when Scout asked.
    const seenSecondsAgo = num(p["seenSecondsAgo"]) ?? 0;
    const observedAt = new Date(meta.collectedAt.getTime() - seenSecondsAgo * 1000);

    const registration = str(p["registration"]);
    const normalized: Record<string, unknown> = {
      icao24: hex,
      callsign: str(p["label"]),
      registration,
      aircraftType: str(p["aircraftType"]),
      altitudeM: num(p["altitudeM"]),
      headingDeg: num(p["heading"]),
      speedKts: num(p["speedKts"]),
      squawk: str(p["squawk"]),
      grounded: p["grounded"] === true,
      tier: str(p["tier"]),
      origin: str(p["origin"]),
      upstream: str(p["source"]),
    };

    out.push({
      sourceId: adsbCollector.id,
      authorizationId: meta.authorizationId,
      collectedAt: meta.collectedAt,
      observedAt,
      rawPayload: feature,
      normalizedPayload: normalized,
      position: { lon, lat },
      // A reported position is a fact from a transponder, not a scored
      // inference. There is no basis to attach a number to.
      confidenceBp: null,
      indeterminate: false,
      ...(meta.caseId === undefined ? {} : { caseId: meta.caseId }),
      identifiers: [
        { kind: "ICAO_HEX", value: hex },
        ...(registration === null ? [] : [{ kind: "TAIL_NUMBER" as const, value: registration }]),
      ],
    });
  }
  return out;
}

export const adsbCollector = {
  ...defineCollector(
    {
      id: "adsb-live",
      name: "ADS-B aircraft (OpenSky Network, adsb.lol, adsb.fi)",
      sourceClass: "SENSOR",
      licensingTerms:
        "OpenSky Network terms of use: free tier is for non-commercial research; commercial use needs a licence. " +
        "adsb.lol and adsb.fi are community feeds under ODbL with attribution. Positions are stored for the case " +
        "under its authorization and are not redistributed.",
      tosUrl: "https://opensky-network.org/about/terms-of-use",
      refreshCadenceSeconds: 20,
      rateLimit: { perMinute: 3 },
      temporalLagSeconds: 5,
      credentialsRef: "OPENSKY_USERNAME",
    },
    normalizeAircraft,
  ),
  entityKind: "AIRCRAFT" as const,
  subjectRequired: false,
  async fetch(): Promise<unknown> {
    const tiers = await Promise.all(TIERS.map((tier) => aircraftIn(tier)()));
    return { type: "FeatureCollection", features: tiers.flatMap((fc) => fc.features) };
  },
};

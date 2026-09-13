import { z } from "zod";
import { defineCollector, type CollectMeta, type ObservationInput } from "@scout/fusion";
import { maritime } from "../../live/feeds/maritime.js";

/**
 * AIS vessel positions, as v2 observations.
 *
 * Two paths into one collector. The keyless one wraps the live map's
 * maritime assembly (Kystverket for Norway, Digitraffic for Finland), the
 * way the ADS-B collector wraps the aircraft assembly: national authorities
 * publishing their own waters, each vessel naming the authority that saw
 * it. The keyed one is AISStream.io, which relays global AIS over a
 * websocket; with `AISSTREAM_API_KEY` set the run also subscribes for a
 * short window and keeps the latest position per MMSI. Both write the same
 * observation shape and say which upstream they came from.
 */

export const AISSTREAM_KEY_ENV = "AISSTREAM_API_KEY";
export const AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream";

export const aisParamsSchema = z.object({
  /** west, south, east, north. Default: the whole world. */
  bbox: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
  /** How long to listen to the stream. Bounded: a collector run is a request, not a subscription. */
  windowSeconds: z.number().int().min(1).max(60).default(15),
});
export type AisParams = z.infer<typeof aisParamsSchema>;

export interface VesselSighting {
  mmsi: string;
  name: string | null;
  imo: string | null;
  callsign: string | null;
  shipType: string | null;
  destination: string | null;
  speedKn: number | null;
  headingDeg: number | null;
  lon: number;
  lat: number;
  /** ISO time the vessel reported, when the upstream gives one. */
  at: string | null;
  upstream: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The live map's vessel features, as sightings. Ports and chokepoints are not vessels and are dropped. */
export function sightingsFromMaritime(collection: { features: Array<{ geometry: { coordinates: unknown }; properties: Record<string, unknown> }> }): VesselSighting[] {
  const out: VesselSighting[] = [];
  for (const f of collection.features) {
    const p = f.properties;
    if (p["role"] !== "vessel") continue;
    const mmsi = p["mmsi"];
    const coords = f.geometry.coordinates;
    if ((typeof mmsi !== "number" && typeof mmsi !== "string") || !Array.isArray(coords)) continue;
    const lon = num(coords[0]);
    const lat = num(coords[1]);
    if (lon === null || lat === null) continue;
    const label = str(p["label"]);
    out.push({
      mmsi: String(mmsi),
      name: label !== null && !label.startsWith("MMSI ") ? label : null,
      imo: p["imo"] === null || p["imo"] === undefined ? null : String(p["imo"]),
      callsign: str(p["callsign"]),
      shipType: str(p["shipType"]),
      destination: str(p["destination"]),
      speedKn: num(p["speedKn"]),
      headingDeg: num(p["heading"]),
      lon,
      lat,
      at: str(p["at"]),
      upstream: str(p["authority"]) ?? "national-ais",
    });
  }
  return out;
}

/** The subset of a websocket this collector needs, so a test can hand in a fake. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown; message?: string }) => void): void;
}

const positionReport = z.object({
  MessageType: z.literal("PositionReport"),
  MetaData: z.object({
    MMSI: z.union([z.number(), z.string()]),
    ShipName: z.string().optional(),
    latitude: z.number(),
    longitude: z.number(),
    time_utc: z.string().optional(),
  }),
  Message: z.object({
    PositionReport: z.object({ Cog: z.number().optional(), Sog: z.number().optional(), TrueHeading: z.number().optional() }).partial(),
  }),
});

/**
 * Subscribe to AISStream for a bounded window and keep the latest position
 * per MMSI. The subscription names the box and asks for position reports
 * only; the socket is closed when the window ends, whatever the upstream
 * would have liked.
 */
export function collectAisStream(input: { apiKey: string; params: AisParams; open: (url: string) => SocketLike; now?: () => number }): Promise<VesselSighting[]> {
  const [w, s, e, n] = input.params.bbox ?? [-180, -90, 180, 90];
  return new Promise((resolve, reject) => {
    const latest = new Map<string, VesselSighting>();
    let settled = false;
    const socket = input.open(AISSTREAM_URL);
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // Already closed by the upstream; the sightings are what matter.
      }
      resolve([...latest.values()]);
    };
    const timer = setTimeout(finish, input.params.windowSeconds * 1000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ APIKey: input.apiKey, BoundingBoxes: [[[s, w], [n, e]]], FilterMessageTypes: ["PositionReport"] }));
    });
    socket.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      const report = positionReport.safeParse(parsed);
      if (!report.success) return;
      const m = report.data.MetaData;
      const r = report.data.Message.PositionReport;
      const mmsi = String(m.MMSI);
      const name = str(m.ShipName);
      latest.set(mmsi, {
        mmsi,
        name,
        imo: null,
        callsign: null,
        shipType: null,
        destination: null,
        speedKn: num(r.Sog),
        headingDeg: num(r.TrueHeading) ?? num(r.Cog),
        lon: m.longitude,
        lat: m.latitude,
        at: str(m.time_utc),
        upstream: "AISStream.io",
      });
    });
    socket.addEventListener("error", (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`AISStream: ${event.message ?? "socket error"}`));
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/** AISStream's `time_utc` is "2026-09-13 12:34:56.789 +0000 UTC"; national feeds give ISO. Either way, a Date or null. */
export function parseSightingTime(at: string | null, fallback: Date): Date {
  if (at === null) return fallback;
  const iso = new Date(at);
  if (!Number.isNaN(iso.getTime())) return iso;
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(at);
  if (m === null) return fallback;
  const d = new Date(`${m[1]}T${m[2]}${m[3] === undefined ? "" : `.${m[3].slice(0, 3)}`}Z`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export function normalizeVessels(raw: unknown, meta: CollectMeta): ObservationInput[] {
  const sightings = Array.isArray((raw as { sightings?: unknown })?.sightings) ? ((raw as { sightings: VesselSighting[] }).sightings) : [];
  return sightings.map((v) => ({
    sourceId: aisCollector.id,
    authorizationId: meta.authorizationId,
    collectedAt: meta.collectedAt,
    observedAt: parseSightingTime(v.at, meta.collectedAt),
    rawPayload: v,
    normalizedPayload: {
      mmsi: v.mmsi,
      name: v.name,
      imo: v.imo,
      callsign: v.callsign,
      shipType: v.shipType,
      destination: v.destination,
      speedKn: v.speedKn,
      headingDeg: v.headingDeg,
      upstream: v.upstream,
    },
    position: { lon: v.lon, lat: v.lat },
    // A transponder position is reported, not inferred.
    confidenceBp: null,
    indeterminate: false,
    entityKind: "VESSEL" as const,
    ...(meta.caseId === undefined ? {} : { caseId: meta.caseId }),
    identifiers: [
      { kind: "MMSI" as const, value: v.mmsi },
      ...(v.imo === null ? [] : [{ kind: "IMO" as const, value: v.imo }]),
      ...(v.name === null ? [] : [{ kind: "NAME" as const, value: v.name }]),
    ],
  }));
}

const base = defineCollector(
  {
    id: "ais-live",
    name: "AIS vessel positions",
    sourceClass: "SENSOR",
    licensingTerms:
      "National AIS feeds under their publishers' open-data terms: Kystverket (Norway, NLOD) and Digitraffic (Finland, CC BY 4.0), attribution kept on every row. " +
      "AISStream.io relays global AIS under its terms of service when AISSTREAM_API_KEY is set; without a key the collector covers the national feeds only.",
    tosUrl: "https://aisstream.io/documentation",
    rateLimit: { perMinute: 4 },
    refreshCadenceSeconds: 60,
    spatialResolutionMeters: 10,
    temporalLagSeconds: 60,
    credentialsRef: AISSTREAM_KEY_ENV,
  },
  normalizeVessels,
);

export const aisCollector = {
  ...base,
  entityKind: "VESSEL" as const,
  subjectRequired: false,
  paramsSchema: aisParamsSchema,
  async fetch(input: { params?: Record<string, unknown> | undefined }) {
    const params = aisParamsSchema.parse(input.params ?? {});
    const national = sightingsFromMaritime((await maritime()) as never);
    const key = process.env[AISSTREAM_KEY_ENV]?.trim() ?? "";
    const streamed =
      key === ""
        ? []
        : await collectAisStream({ apiKey: key, params, open: (url) => new WebSocket(url) as unknown as SocketLike });
    const box = params.bbox;
    const inside = (v: VesselSighting) => box === undefined || (v.lon >= box[0] && v.lon <= box[2] && v.lat >= box[1] && v.lat <= box[3]);
    return { sightings: [...national, ...streamed].filter(inside) };
  },
};

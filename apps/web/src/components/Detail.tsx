"use client";

import type { Selection } from "./GlobeMap";
import { LAYER_BY_ID } from "@/lib/layers";

/**
 * The feature card.
 *
 * Each layer knows things the others do not — an aircraft has a squawk, a
 * camera has a stream, a nuclear plant has a reactor count. A single generic
 * key/value dump would show all of it and mean none of it, so the fields that
 * matter are named per layer and the rest is dropped rather than padded out.
 */

const HIDDEN = new Set(["layer", "label", "colour", "role", "id"]);

interface Row {
  key: string;
  value: string;
}

function rows(properties: Record<string, unknown>, keys: string[]): Row[] {
  const out: Row[] = [];
  for (const key of keys) {
    const value = properties[key];
    if (value === null || value === undefined || value === "") continue;
    out.push({ key, value: String(value) });
  }
  return out;
}

const LABELS: Record<string, string> = {
  icao24: "ICAO 24",
  aircraftType: "Type",
  altitudeM: "Altitude",
  speedKts: "Speed",
  registration: "Registration",
  noradId: "NORAD ID",
  altitudeKm: "Altitude",
  capacityMW: "Capacity",
  asName: "Network",
  asn: "AS",
  urlCount: "Payload URLs",
  liveVessels: "Vessels in view",
  oilTransit: "Oil transit",
  alertLevel: "Alert level",
  depthKm: "Depth",
  speedKn: "Speed",
  streamType: "Stream",
  throughput: "Throughput",
  probability: "Probability",
  stormLevel: "Storm level",
  kp: "Kp index",
  frp: "Radiative power",
};

/** Per-layer field order. Anything not listed here is not shown. */
const FIELDS: Record<string, string[]> = {
  "aircraft:commercial": ["callsign", "registration", "aircraftType", "altitudeM", "speedKts", "heading", "squawk", "emergency", "origin", "icao24", "source"],
  "aircraft:private": ["registration", "aircraftType", "altitudeM", "speedKts", "heading", "squawk", "emergency", "origin", "icao24", "source"],
  "aircraft:jet": ["registration", "aircraftType", "altitudeM", "speedKts", "heading", "squawk", "origin", "icao24", "source"],
  "aircraft:military": ["registration", "aircraftType", "altitudeM", "speedKts", "heading", "squawk", "emergency", "icao24", "source"],
  satellites: ["mission", "category", "altitudeKm", "noradId"],
  maritime: ["country", "rank", "throughput", "congestion", "liveVessels", "oilTransit", "note", "mmsi", "speedKn", "heading", "authority"],
  cctv: ["city", "country", "operator", "streamType"],
  live_news: ["city", "country", "language", "category"],
  earthquakes: ["magnitude", "depthKm", "tsunami", "felt", "at"],
  fires: ["brightness", "confidence", "frp", "at", "source"],
  weather: ["category", "severity", "area", "headline", "at", "source"],
  infrastructure: ["country", "status", "capacityMW", "operator"],
  global_incidents: ["category", "alertLevel", "severity", "country", "description", "at"],
  gdelt_events: ["theme", "tone", "at"],
  malware: ["ip", "malware", "threatType", "status", "urlCount", "city", "country", "asName", "asn", "tags", "firstSeen", "reporter"],
  cyber_attacks: ["ip", "port", "malware", "status", "hostname", "city", "country", "asName", "asn", "firstSeen", "lastOnline"],
  space_weather: ["kp", "stormLevel", "flareClass", "at"],
  aurora: ["probability", "at"],
  cables: [],
};

function format(key: string, value: string): string {
  if (key === "altitudeM") return `${Number(value).toLocaleString()} m`;
  if (key === "altitudeKm") return `${Number(value).toLocaleString()} km`;
  if (key === "speedKts") return `${value} kt`;
  if (key === "speedKn") return `${value} kn`;
  if (key === "heading") return `${Math.round(Number(value))}°`;
  if (key === "capacityMW") return `${Number(value).toLocaleString()} MW`;
  if (key === "depthKm") return `${Number(value).toFixed(1)} km`;
  if (key === "probability") return `${value}%`;
  if (key === "magnitude") return `M${Number(value).toFixed(1)}`;
  if (key === "at" && /^\d+$/.test(value)) {
    return new Date(Number(value)).toISOString().replace("T", " ").slice(0, 19) + "Z";
  }
  return value;
}

export function Detail({
  selection,
  onClose,
  onFly,
  track,
}: {
  selection: Selection;
  onClose: () => void;
  onFly: (place: { lat: number; lon: number; zoom?: number }) => void;
  track?: {
    path: [number, number][];
    route: {
      from: { code: string | null; place: string | null };
      to: { code: string | null; place: string | null };
    } | null;
  } | null;
}) {
  const properties = selection.properties;
  const layerId = String(properties["layer"] ?? selection.layer);
  const baseId = layerId.startsWith("aircraft:") ? layerId : layerId;
  const def = LAYER_BY_ID.get(layerId.replace(/^aircraft:.*/, ""));

  const wanted = FIELDS[baseId];
  const shown =
    wanted !== undefined
      ? rows(properties, wanted)
      : rows(
          properties,
          Object.keys(properties).filter((k) => !HIDDEN.has(k)),
        ).slice(0, 12);

  const url = typeof properties["url"] === "string" ? properties["url"] : null;
  const streamUrl =
    typeof properties["streamUrl"] === "string" ? properties["streamUrl"] : null;
  const stillUrl =
    typeof properties["stillUrl"] === "string" && properties["stillUrl"].length > 0
      ? properties["stillUrl"]
      : null;
  const streamType = String(properties["streamType"] ?? "");
  const emergency =
    typeof properties["emergency"] === "string" ? properties["emergency"] : null;

  return (
    <aside className="hud-detail">
      <div className="hud-detail-head">
        <span
          className="hud-dot"
          style={{
            background: String(properties["colour"] ?? def?.colour ?? "#8e8e93"),
          }}
        />
        <h2>{selection.label}</h2>
        <button className="link" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {emergency !== null ? (
        <p className="detail-alarm">Squawking {emergency}</p>
      ) : null}

      {/*
        * A still image is shown inline; anything else is a link. Embedding an
        * agency's video player would mean loading their scripts into this
        * page, which is not a trade worth making for a thumbnail.
        */}
      {stillUrl !== null ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="detail-still" src={stillUrl} alt={selection.label} />
      ) : null}

      <dl>
        {shown.map(({ key, value }) => (
          <div key={key}>
            <dt>{LABELS[key] ?? key.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
            <dd>{format(key, value)}</dd>
          </div>
        ))}
        <div>
          <dt>position</dt>
          <dd>
            {selection.lngLat.lat.toFixed(4)}, {selection.lngLat.lng.toFixed(4)}
          </dd>
        </div>
      </dl>

      {track != null && (track.path.length > 1 || track.route !== null) ? (
        <p className="detail-track">
          {track.route !== null ? (
            <span>
              {track.route.from.code ?? "?"}{" "}
              <span className="detail-arrow">→</span>{" "}
              {track.route.to.code ?? "?"}
              {track.route.to.place !== null ? ` (${track.route.to.place})` : ""}
            </span>
          ) : null}
          {track.path.length > 1 ? (
            <span className="detail-trail">
              {track.path.length} recorded positions
            </span>
          ) : null}
        </p>
      ) : null}

      {def !== undefined ? (
        <p className="detail-source">{def.source}</p>
      ) : null}

      <div className="detail-actions">
        <button
          onClick={() =>
            onFly({ lat: selection.lngLat.lat, lon: selection.lngLat.lng, zoom: 9 })
          }
        >
          Centre
        </button>
        {streamUrl !== null && streamType !== "image" ? (
          <a href={streamUrl} target="_blank" rel="noreferrer noopener">
            Open stream
          </a>
        ) : null}
        {url !== null ? (
          <a href={url} target="_blank" rel="noreferrer noopener">
            Source
          </a>
        ) : null}
      </div>
    </aside>
  );
}

"use client";

import dynamic from "next/dynamic";
import type { Selection } from "./GlobeMap";
import { LAYER_BY_ID } from "@/lib/layers";

// Browser-only: hls.js must not enter the server or prerender bundle.
const HlsVideo = dynamic(() => import("./HlsVideo"), { ssr: false });

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

/**
 * Labels for keys not in LABELS: acronyms upper-cased, every other word title
 * cased. "mmsi" → "MMSI", "heading" → "Heading", "sourceId" → "Source ID".
 */
const ACRONYMS = new Set(["mmsi", "imo", "icao", "ip", "id", "url", "mw", "utc", "eta", "aoi", "gps", "vhf"]);

function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_]+/)
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

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
  investigation: ["kind", "sourceId", "observedAt"],
  "investigation-density": ["count", "sources", "kinds", "latestObservedAt"],
  "investigation-cluster": ["size"],
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
  if (value === "true" || value === "false") return value.toUpperCase();
  return value;
}

/**
 * A YouTube watch/live URL as an /embed URL, or null. YouTube is the one
 * third-party player embedded inline: the iframe loads YouTube's player, not
 * the source site's own scripts.
 */
function youtubeEmbed(u: string | null): string | null {
  if (u === null) return null;
  const m = u.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|live\/|v\/)|youtu\.be\/)([\w-]{11})/,
  );
  return m ? `https://www.youtube.com/embed/${m[1]}?autoplay=1&mute=1&playsinline=1` : null;
}

/**
 * The camera view, inline. An embeddable page (YouTube, or streamType
 * "iframe") plays in an iframe; an HLS playlist plays in a <video>, with hls.js
 * loaded on demand where the browser cannot play HLS natively; anything else
 * falls back to a still image. Renders nothing for features that carry none of
 * these, so it is safe on every layer.
 */
function CctvMedia({
  label,
  streamType,
  streamUrl,
  stillUrl,
  url,
}: {
  label: string;
  streamType: string;
  streamUrl: string | null;
  stillUrl: string | null;
  url: string | null;
}) {
  const embed =
    youtubeEmbed(streamUrl) ??
    youtubeEmbed(url) ??
    (streamType === "iframe" ? streamUrl : null);
  const hlsUrl =
    streamType === "hls" && streamUrl !== null && embed === null ? streamUrl : null;

  if (embed !== null) {
    return (
      <iframe
        className="detail-video"
        src={embed}
        title={label}
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    );
  }
  if (hlsUrl !== null) {
    return <HlsVideo src={hlsUrl} label={label} />;
  }
  if (stillUrl !== null) {
    return <img className="detail-still" src={stillUrl} alt={label} />;
  }
  return null;
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
        {/* Which layer this came from. Colours are reused across layers, so the
            dot alone cannot answer "what did I just click". */}
        {def !== undefined ? <span className="hud-layer">{def.name}</span> : null}
        <button className="link" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {emergency !== null ? (
        <p className="detail-alarm">Squawking {emergency}</p>
      ) : null}

      <CctvMedia
        label={selection.label}
        streamType={streamType}
        streamUrl={streamUrl}
        stillUrl={stillUrl}
        url={url}
      />

      <dl>
        {shown.map(({ key, value }) => (
          <div key={key}>
            <dt>{LABELS[key] ?? humanize(key)}</dt>
            <dd>{format(key, value)}</dd>
          </div>
        ))}
        <div>
          <dt>Position</dt>
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

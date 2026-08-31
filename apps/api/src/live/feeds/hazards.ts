import { z } from "zod";
import { getJson } from "../http.js";
import { point, usable, type FeatureCollection } from "../types.js";

/** Natural hazards: earthquakes, active fires, severe weather, and incidents. */

// ── Earthquakes ────────────────────────────────────────────────────────────

const USGS_SCHEMA = z.object({
  features: z
    .array(
      z.object({
        id: z.string().optional(),
        properties: z
          .object({
            mag: z.number().nullable().default(null),
            place: z.string().nullable().default(null),
            time: z.number().nullable().default(null),
            url: z.string().nullable().default(null),
            tsunami: z.number().nullable().default(null),
            felt: z.number().nullable().default(null),
          })
          .partial(),
        geometry: z
          .object({ coordinates: z.array(z.number()) })
          .nullable()
          .default(null),
      }),
    )
    .default([]),
});

export async function earthquakes(): Promise<FeatureCollection> {
  const parsed = USGS_SCHEMA.parse(
    await getJson(
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",
    ),
  );

  return {
    type: "FeatureCollection",
    features: parsed.features.flatMap((feature) => {
      const coordinates = feature.geometry?.coordinates ?? [];
      const [lon, lat, depth] = coordinates;
      if (!usable(lon, lat)) return [];

      return [
        point(lon, lat as number, {
          layer: "earthquakes",
          id: feature.id ?? `${lon},${lat}`,
          label: feature.properties.place ?? "Earthquake",
          magnitude: feature.properties.mag,
          depthKm: depth ?? null,
          tsunami: feature.properties.tsunami === 1,
          felt: feature.properties.felt,
          at: feature.properties.time,
          url: feature.properties.url,
          colour: "#ff9f0a",
        }),
      ];
    }),
  };
}

// ── Fires ──────────────────────────────────────────────────────────────────

/**
 * Active fire detections.
 *
 * NASA FIRMS is the authoritative source and needs a free self-serve MAP_KEY;
 * when `FIRMS_MAP_KEY` is set, that is what runs, giving individual satellite
 * detections with brightness and radiative power.
 *
 * Without it the layer still works, from EONET's open wildfire events. The
 * difference is real and worth knowing: EONET publishes a few hundred *named
 * fire events*, FIRMS publishes tens of thousands of *pixel detections* from
 * the last 24 hours. The layer says which one it is rather than quietly being
 * a hundred times sparser than it looks.
 */
const FIRMS_SCHEMA = z.array(z.array(z.string()));

async function firmsFires(key: string): Promise<FeatureCollection> {
  const csv = await getJson<string>(
    `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/world/1`,
  ).catch(async () => {
    // The endpoint serves CSV, not JSON; getJson is only used above to reuse
    // the headers, so fall through to a text fetch on the parse failure.
    const { getText } = await import("../http.js");
    return getText(
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/world/1`,
      { timeoutMs: 60_000 },
    );
  });

  const rows = csv.trim().split("\n");
  const header = (rows.shift() ?? "").split(",");
  const index = (name: string) => header.indexOf(name);
  const iLat = index("latitude");
  const iLon = index("longitude");
  const iBright = index("bright_ti4");
  const iConf = index("confidence");
  const iFrp = index("frp");
  const iDate = index("acq_date");
  const iTime = index("acq_time");
  if (iLat < 0 || iLon < 0) throw new Error("FIRMS returned an unexpected CSV");

  const parsed = FIRMS_SCHEMA.parse(rows.map((row) => row.split(",")));
  return {
    type: "FeatureCollection",
    features: parsed.flatMap((cells, n) => {
      const lon = Number(cells[iLon]);
      const lat = Number(cells[iLat]);
      if (!usable(lon, lat)) return [];
      return [
        point(lon, lat, {
          layer: "fires",
          id: `firms-${n}`,
          label: "Fire detection",
          brightness: Number(cells[iBright] ?? 0) || null,
          confidence: cells[iConf] ?? null,
          frp: Number(cells[iFrp] ?? 0) || null,
          at: `${cells[iDate] ?? ""} ${cells[iTime] ?? ""}`.trim(),
          source: "NASA FIRMS (VIIRS)",
          colour: "#ff6b35",
        }),
      ];
    }),
    meta: { source: "NASA FIRMS (VIIRS)", resolution: "detections" },
  };
}

const EONET_SCHEMA = z.object({
  events: z
    .array(
      z.object({
        id: z.string().optional(),
        title: z.string().default(""),
        link: z.string().optional(),
        categories: z
          .array(z.object({ id: z.string().optional(), title: z.string().optional() }))
          .default([]),
        sources: z.array(z.object({ url: z.string().optional() })).default([]),
        geometry: z
          .array(
            z.object({
              date: z.string().optional(),
              type: z.string().optional(),
              coordinates: z.unknown(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

async function eonet(category: string | null, limit = 500) {
  const url = new URL("https://eonet.gsfc.nasa.gov/api/v3/events");
  url.searchParams.set("status", "open");
  url.searchParams.set("limit", String(limit));
  if (category !== null) url.searchParams.set("category", category);
  return EONET_SCHEMA.parse(await getJson(url.toString()));
}

/** An EONET event carries a track; the last point is where it is now. */
function latestPosition(
  event: z.infer<typeof EONET_SCHEMA>["events"][number],
): { lon: number; lat: number; date: string | null } | null {
  const latest = event.geometry[event.geometry.length - 1];
  const coordinates = latest?.coordinates;
  if (!Array.isArray(coordinates)) return null;

  // A polygon arrives as nested rings; take its first vertex rather than
  // dropping the event entirely.
  const flat = Array.isArray(coordinates[0])
    ? (coordinates.flat(3) as number[])
    : (coordinates as number[]);
  const [lon, lat] = flat;
  if (!usable(lon, lat)) return null;
  return { lon, lat: lat as number, date: latest?.date ?? null };
}

export async function fires(): Promise<FeatureCollection> {
  const key = process.env["FIRMS_MAP_KEY"];
  if (key !== undefined && key.length > 0) {
    return firmsFires(key);
  }

  const parsed = await eonet("wildfires");
  return {
    type: "FeatureCollection",
    features: parsed.events.flatMap((event) => {
      const position = latestPosition(event);
      if (position === null) return [];
      return [
        point(position.lon, position.lat, {
          layer: "fires",
          id: event.id ?? event.title,
          label: event.title,
          at: position.date,
          url: event.link ?? null,
          source: "NASA EONET",
          colour: "#ff6b35",
        }),
      ];
    }),
    meta: {
      source: "NASA EONET",
      resolution: "events",
      note: "Named fire events. Set FIRMS_MAP_KEY for individual VIIRS detections.",
    },
  };
}

// ── Severe weather ─────────────────────────────────────────────────────────

const NWS_SCHEMA = z.object({
  features: z
    .array(
      z.object({
        id: z.string().optional(),
        properties: z
          .object({
            event: z.string().optional(),
            headline: z.string().nullable().optional(),
            severity: z.string().optional(),
            urgency: z.string().optional(),
            areaDesc: z.string().optional(),
            effective: z.string().optional(),
            senderName: z.string().optional(),
          })
          .partial(),
        geometry: z.unknown().nullable().default(null),
      }),
    )
    .default([]),
});

/**
 * Severe weather, from two sources that do different jobs.
 *
 * EONET carries named global events — the storms with names, tracked over
 * days. The US National Weather Service carries active warnings, which are
 * where the immediate danger is but stop at the US border. Together they read
 * as one layer; separately, either alone is misleadingly quiet.
 *
 * NWS alerts are dropped when they carry no geometry. Most warnings are issued
 * against zone codes rather than a polygon, and resolving those would mean
 * fetching a shape per zone — several hundred requests to place warnings that
 * the named-event layer already covers at this zoom.
 */
export async function weather(): Promise<FeatureCollection> {
  const [storms, alerts] = await Promise.allSettled([
    eonet("severeStorms"),
    getJson(
      "https://api.weather.gov/alerts/active?severity=Extreme,Severe&status=actual",
      { timeoutMs: 40_000 },
    ),
  ]);

  const features = [];

  if (storms.status === "fulfilled") {
    for (const event of storms.value.events) {
      const position = latestPosition(event);
      if (position === null) continue;
      features.push(
        point(position.lon, position.lat, {
          layer: "weather",
          id: event.id ?? event.title,
          label: event.title,
          category: event.categories[0]?.title ?? "Severe Storm",
          severity: "high",
          at: position.date,
          url: event.sources[0]?.url ?? event.link ?? null,
          source: "NASA EONET",
          colour: "#4fc3f7",
        }),
      );
    }
  }

  if (alerts.status === "fulfilled") {
    const parsed = NWS_SCHEMA.parse(alerts.value);
    for (const alert of parsed.features) {
      const geometry = alert.geometry as
        | { type?: string; coordinates?: unknown }
        | null;
      if (geometry?.coordinates === undefined) continue;

      const flat = (geometry.coordinates as unknown[]).flat(3) as number[];
      const [lon, lat] = flat;
      if (!usable(lon, lat)) continue;

      features.push(
        point(lon, lat as number, {
          layer: "weather",
          id: alert.id ?? `${lon},${lat}`,
          label: alert.properties.event ?? "Weather warning",
          category: alert.properties.event ?? null,
          severity: (alert.properties.severity ?? "").toLowerCase(),
          area: alert.properties.areaDesc ?? null,
          headline: alert.properties.headline ?? null,
          at: alert.properties.effective ?? null,
          source: alert.properties.senderName ?? "US National Weather Service",
          colour: "#4fc3f7",
        }),
      );
    }
  }

  if (features.length === 0) {
    throw new Error("no severe weather source answered");
  }
  return { type: "FeatureCollection", features };
}

// ── Global incidents ───────────────────────────────────────────────────────

const GDACS_SCHEMA = z.object({
  features: z
    .array(
      z.object({
        properties: z
          .object({
            eventid: z.union([z.number(), z.string()]).optional(),
            eventtype: z.string().optional(),
            eventname: z.string().nullable().optional(),
            htmldescription: z.string().optional(),
            description: z.string().optional(),
            alertlevel: z.string().optional(),
            alertscore: z.number().nullable().optional(),
            country: z.string().nullable().optional(),
            fromdate: z.string().optional(),
            url: z
              .object({ report: z.string().optional() })
              .partial()
              .nullable()
              .optional(),
            severitydata: z
              .object({ severitytext: z.string().optional() })
              .partial()
              .nullable()
              .optional(),
          })
          .partial(),
        geometry: z
          .object({ coordinates: z.array(z.number()) })
          .nullable()
          .default(null),
      }),
    )
    .default([]),
});

const EVENT_TYPE: Record<string, string> = {
  EQ: "Earthquake",
  TC: "Tropical Cyclone",
  FL: "Flood",
  VO: "Volcano",
  DR: "Drought",
  WF: "Wildfire",
};

const ALERT_COLOUR: Record<string, string> = {
  Red: "#ff3b52",
  Orange: "#ff9f0a",
  Green: "#35c46a",
};

/**
 * GDACS — the UN and European Commission disaster alert system.
 *
 * Its alert level (green, orange, red) is a published assessment of expected
 * humanitarian impact, not something computed here, so it is passed through
 * as-is and coloured accordingly.
 */
export async function incidents(): Promise<FeatureCollection> {
  const parsed = GDACS_SCHEMA.parse(
    await getJson(
      "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH",
      { timeoutMs: 40_000 },
    ),
  );

  return {
    type: "FeatureCollection",
    features: parsed.features.flatMap((event) => {
      const [lon, lat] = event.geometry?.coordinates ?? [];
      if (!usable(lon, lat)) return [];

      const p = event.properties;
      const type = EVENT_TYPE[p.eventtype ?? ""] ?? (p.eventtype ?? "Incident");
      const level = p.alertlevel ?? "Green";

      return [
        point(lon, lat as number, {
          layer: "global_incidents",
          id: `gdacs-${p.eventtype ?? ""}-${p.eventid ?? ""}`,
          label: p.eventname?.trim() || `${type}${p.country ? ` — ${p.country}` : ""}`,
          category: type,
          alertLevel: level,
          severity: p.severitydata?.severitytext ?? null,
          country: p.country ?? null,
          description: p.description ?? null,
          at: p.fromdate ?? null,
          url: p.url?.report ?? null,
          colour: ALERT_COLOUR[level] ?? "#ff3b52",
        }),
      ];
    }),
  };
}

import { z } from "zod";
import { persistent } from "../cache.js";
import { getJson, getText } from "../http.js";
import { point, usable, type Feature, type FeatureCollection } from "../types.js";

/**
 * Volcanoes, in two registers.
 *
 * The base layer is the Smithsonian's Holocene catalogue — every volcano that
 * has erupted in the last twelve thousand years, which is the set that could
 * erupt again. It does not change, so it is cached for a week.
 *
 * On top of it, two live signals: the US Geological Survey's elevated alert
 * levels with their published colour code, and the Smithsonian's weekly
 * activity reports. Both are passed through as issued — the alert level is an
 * observatory's assessment, not something computed here.
 *
 * This pairs directly with the SIGMET layer, where a volcanic-ash polygon and
 * an eruption report describe the same event from two directions.
 */

// ── The catalogue ──────────────────────────────────────────────────────────

const GVP_WFS =
  "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/wfs?service=WFS&version=2.0.0&request=GetFeature&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes&outputFormat=application/json";

const CATALOGUE_SCHEMA = z.object({
  features: z
    .array(
      z.object({
        properties: z
          .object({
            Volcano_Number: z.union([z.number(), z.string()]).optional(),
            Volcano_Name: z.string().nullable().optional(),
            Country: z.string().nullable().optional(),
            Primary_Volcano_Type: z.string().nullable().optional(),
            Last_Eruption_Year: z.union([z.number(), z.string()]).nullable().optional(),
            Elevation: z.union([z.number(), z.string()]).nullable().optional(),
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

const WEEK_MS = 7 * 24 * 60 * 60_000;

async function loadCatalogue() {
  const parsed = CATALOGUE_SCHEMA.parse(
    await getJson(GVP_WFS, { timeoutMs: 60_000 }),
  );
  return parsed.features.flatMap((feature) => {
    const [lon, lat] = feature.geometry?.coordinates ?? [];
    if (!usable(lon, lat)) return [];
    const p = feature.properties;
    return [
      {
        vnum: String(p.Volcano_Number ?? ""),
        name: p.Volcano_Name ?? "Volcano",
        country: p.Country ?? null,
        type: p.Primary_Volcano_Type ?? null,
        lastEruption: p.Last_Eruption_Year ?? null,
        elevationM: p.Elevation ?? null,
        lon,
        lat: lat as number,
      },
    ];
  });
}

// ── Live alert levels ──────────────────────────────────────────────────────

const USGS_SCHEMA = z.array(
  z.object({
    volcano_name_appended: z.string().nullable().optional(),
    latitude: z.number(),
    longitude: z.number(),
    vnum: z.string().nullable().optional(),
    elevation_meters: z.number().nullable().optional(),
    obs_fullname: z.string().nullable().optional(),
    alert_level: z.string().nullable().optional(),
    color_code: z.string().nullable().optional(),
    sent_utc: z.string().nullable().optional(),
  }),
);

/** The published aviation colour code. Not a scale invented here. */
const CODE_COLOUR: Record<string, string> = {
  RED: "#ff3b52",
  ORANGE: "#ff9f0a",
  YELLOW: "#ffd60a",
  GREEN: "#35c46a",
  UNASSIGNED: "#8e8e93",
};

export async function volcanoes(): Promise<FeatureCollection> {
  const [catalogueResult, alertsResult, reportsResult] = await Promise.allSettled([
    persistent("gvp-catalogue", WEEK_MS, 30 * WEEK_MS, loadCatalogue),
    getJson("https://volcanoes.usgs.gov/hans-public/api/volcano/getCapElevated", {
      timeoutMs: 30_000,
    }),
    getText("https://volcano.si.edu/news/WeeklyVolcanoRSS.xml", {
      // 403s without one.
      headers: { "user-agent": "Scout-OSINT/0.1 (+authorized-engagement-tooling)" },
      timeoutMs: 30_000,
    }),
  ]);

  const catalogue = catalogueResult.status === "fulfilled" ? catalogueResult.value : [];

  /** vnum to the live alert, so the catalogue entry can carry it. */
  const alerts = new Map<
    string,
    { level: string; code: string; observatory: string | null; at: string | null }
  >();
  if (alertsResult.status === "fulfilled") {
    const parsed = USGS_SCHEMA.safeParse(alertsResult.value);
    for (const row of parsed.data ?? []) {
      const key = String(row.vnum ?? "");
      if (key.length === 0) continue;
      alerts.set(key, {
        level: row.alert_level ?? "UNKNOWN",
        code: (row.color_code ?? "UNASSIGNED").toUpperCase(),
        observatory: row.obs_fullname ?? null,
        at: row.sent_utc ?? null,
      });
    }
  }

  /**
   * Volcano names mentioned in this week's activity report.
   *
   * Matched by name because the RSS carries no volcano number. That is loose,
   * so it only ever adds a note — it never sets an alert level, which is the
   * field an operator would act on.
   */
  const reported = new Set<string>();
  if (reportsResult.status === "fulfilled") {
    for (const match of reportsResult.value.matchAll(/<title>([^<]+)<\/title>/g)) {
      const title = (match[1] ?? "").split("(")[0]?.trim();
      if (title !== undefined && title.length > 2) reported.add(title.toLowerCase());
    }
  }

  const features: Feature[] = catalogue.map((volcano) => {
    const alert = alerts.get(volcano.vnum);
    const active = reported.has(volcano.name.toLowerCase());

    return point(volcano.lon, volcano.lat, {
      layer: "volcanoes",
      id: `gvp-${volcano.vnum}`,
      label: volcano.name,
      country: volcano.country,
      volcanoType: volcano.type,
      elevationM: volcano.elevationM,
      lastEruption: volcano.lastEruption,
      alertLevel: alert?.level ?? null,
      aviationColour: alert?.code ?? null,
      observatory: alert?.observatory ?? null,
      alertAt: alert?.at ?? null,
      inWeeklyReport: active,
      url: `https://volcano.si.edu/volcano.cfm?vn=${volcano.vnum}`,
      // A volcano with a live alert takes the published code. Everything else
      // is the dormant grey of the catalogue — the colour has to mean the
      // alert, or it means nothing.
      colour:
        alert !== undefined
          ? (CODE_COLOUR[alert.code] ?? "#8e8e93")
          : active
            ? "#ffd60a"
            : "#6b5b4a",
    });
  });

  if (features.length === 0) throw new Error("the volcano catalogue did not load");

  return {
    type: "FeatureCollection",
    features,
    meta: {
      catalogue: features.length,
      elevatedAlerts: alerts.size,
      inWeeklyReport: reported.size,
      source: "Smithsonian Global Volcanism Program and USGS",
    },
  };
}

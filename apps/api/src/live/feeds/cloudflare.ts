import { z } from "zod";
import { getJson } from "../http.js";
import { point, usable, type FeatureCollection } from "../types.js";
import { COUNTRY_CENTROIDS } from "../data/countries.js";

/**
 * Cloudflare Radar — internet outages and attack origins.
 *
 * The only layers here that need a key. Radar's API requires a Cloudflare API
 * token, so rather than shipping two permanently broken toggles, these are
 * capability-gated: with no token the layers are not offered at all, and the
 * rail simply does not show them.
 *
 * That is a deliberate exception to Scout's usual rule of listing every source
 * with a reason. A source that is inert because a key is missing belongs in
 * the OSINT results, where an operator is looking for what could have run. A
 * map layer that can never draw is just a dead switch.
 *
 * Set CLOUDFLARE_API_TOKEN to a token with the Radar read permission.
 */

const BASE = "https://api.cloudflare.com/client/v4/radar";

export function cloudflareConfigured(): boolean {
  const token = process.env["CLOUDFLARE_API_TOKEN"];
  return token !== undefined && token.length > 0;
}

function auth(): Record<string, string> {
  return { authorization: `Bearer ${process.env["CLOUDFLARE_API_TOKEN"] ?? ""}` };
}

const OUTAGE_SCHEMA = z.object({
  result: z.object({
    annotations: z
      .array(
        z.object({
          id: z.union([z.string(), z.number()]).optional(),
          asns: z.array(z.number()).optional(),
          asnsDetails: z
            .array(z.object({ asn: z.string().optional(), name: z.string().optional() }))
            .optional(),
          locations: z.array(z.string()).optional(),
          locationsDetails: z
            .array(z.object({ code: z.string().optional(), name: z.string().optional() }))
            .optional(),
          eventType: z.string().optional(),
          scope: z.string().optional(),
          description: z.string().nullable().optional(),
          startDate: z.string().optional(),
          endDate: z.string().nullable().optional(),
          linkedUrl: z.string().nullable().optional(),
        }),
      )
      .default([]),
  }),
});

/**
 * Outages are reported against a country or an autonomous system, not a
 * coordinate, so each one is placed at its country's centroid. That is a real
 * approximation and the feature says so — a national outage does not have a
 * location, and drawing it at a made-up city would be worse.
 */
export async function cloudflareOutages(): Promise<FeatureCollection> {
  const parsed = OUTAGE_SCHEMA.parse(
    await getJson(`${BASE}/annotations/outages?limit=200&format=json`, {
      headers: auth(),
      timeoutMs: 30_000,
    }),
  );

  return {
    type: "FeatureCollection",
    features: parsed.result.annotations.flatMap((outage) => {
      const code = outage.locations?.[0] ?? outage.locationsDetails?.[0]?.code;
      const centroid = code === undefined ? undefined : COUNTRY_CENTROIDS[code];
      if (centroid === undefined) return [];
      const [lon, lat] = centroid;
      if (!usable(lon, lat)) return [];

      const ongoing = outage.endDate === null || outage.endDate === undefined;
      return [
        point(lon, lat, {
          layer: "cf_outages",
          id: `cf-outage-${outage.id ?? `${code}-${outage.startDate ?? ""}`}`,
          label: `${outage.locationsDetails?.[0]?.name ?? code} — ${outage.eventType ?? "outage"}`,
          country: outage.locationsDetails?.[0]?.name ?? code,
          eventType: outage.eventType ?? null,
          scope: outage.scope ?? null,
          network: outage.asnsDetails?.[0]?.name ?? null,
          description: outage.description ?? null,
          startedAt: outage.startDate ?? null,
          endedAt: outage.endDate ?? null,
          ongoing,
          url: outage.linkedUrl ?? null,
          position: "Country centroid — an outage is national, not a point.",
          colour: ongoing ? "#ff3b52" : "#8e8e93",
        }),
      ];
    }),
    meta: { source: "Cloudflare Radar" },
  };
}

const ATTACK_SCHEMA = z.object({
  result: z.object({
    top_0: z
      .array(
        z.object({
          originCountryAlpha2: z.string().optional(),
          originCountryName: z.string().optional(),
          value: z.string().optional(),
        }),
      )
      .default([]),
  }),
});

/**
 * Where layer-3 attack traffic originates, as a share of the total.
 *
 * Cloudflare publishes this as a country ranking, so — like the outages — each
 * one sits at a country centroid. It is a proportion of observed attack
 * traffic, not a count of attacks, and the feature carries it as such.
 */
export async function cloudflareAttackOrigins(): Promise<FeatureCollection> {
  const parsed = ATTACK_SCHEMA.parse(
    await getJson(
      `${BASE}/attacks/layer3/top/locations/origin?limit=40&dateRange=1d&format=json`,
      { headers: auth(), timeoutMs: 30_000 },
    ),
  );

  return {
    type: "FeatureCollection",
    features: parsed.result.top_0.flatMap((row) => {
      const code = row.originCountryAlpha2;
      const centroid = code === undefined ? undefined : COUNTRY_CENTROIDS[code];
      if (centroid === undefined) return [];
      const [lon, lat] = centroid;
      const share = Number(row.value ?? 0);

      return [
        point(lon, lat, {
          layer: "cf_attacks",
          id: `cf-attack-${code}`,
          label: `${row.originCountryName ?? code} — ${share.toFixed(2)}% of attack traffic`,
          country: row.originCountryName ?? code,
          share,
          window: "Last 24 hours",
          position: "Country centroid — this is a national share, not a point.",
          colour: share > 5 ? "#ff3b52" : share > 1 ? "#ff9f0a" : "#ffd60a",
        }),
      ];
    }),
    meta: { source: "Cloudflare Radar", window: "1d" },
  };
}

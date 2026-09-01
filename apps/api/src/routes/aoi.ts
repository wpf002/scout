import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { cached } from "../live/cache.js";
import { getText } from "../live/http.js";

/**
 * What fixed infrastructure sits inside a drawn area.
 *
 * The live layers are already held in the browser, so "what is in this box"
 * for aircraft, vessels and incidents is answered there without a request.
 * What the browser does not have is the ground: the power stations, airfields,
 * substations, ports and military sites that make an area worth drawing a box
 * around in the first place.
 *
 * That comes from OpenStreetMap through Overpass, which is a shared volunteer
 * service — so the area is capped, the query carries its own timeout, and
 * results are cached by the exact box asked for.
 *
 * Everything returned carries its OSM type and id, so any claim on the map can
 * be opened in OSM and checked. It is crowd-sourced data and is labelled as
 * such: absence of a feature is not evidence of absence.
 */

const OVERPASS = "https://overpass-api.de/api/interpreter";

/**
 * What is worth asking for. Each is a published OSM tag rather than a guess,
 * and the list is deliberately short — an unfiltered box returns every bench
 * and postbox in it.
 */
const CATEGORIES: Record<string, { name: string; selectors: string[]; colour: string }> = {
  power: {
    name: "Power",
    selectors: ['["power"="plant"]', '["power"="substation"]'],
    colour: "#ffd60a",
  },
  aviation: {
    name: "Aviation",
    selectors: ['["aeroway"="aerodrome"]', '["aeroway"="helipad"]'],
    colour: "#5ac8fa",
  },
  military: {
    name: "Military",
    selectors: ['["landuse"="military"]', '["military"]'],
    colour: "#ff3b52",
  },
  maritime: {
    name: "Ports",
    selectors: ['["industrial"="port"]', '["landuse"="port"]', '["harbour"="yes"]'],
    colour: "#30d0c0",
  },
  telecom: {
    name: "Telecoms",
    selectors: ['["man_made"="mast"]["tower:type"="communication"]', '["telecom"="exchange"]'],
    colour: "#c8b0ff",
  },
  emergency: {
    name: "Emergency",
    selectors: ['["amenity"="hospital"]', '["amenity"="fire_station"]'],
    colour: "#35c46a",
  },
};

const ELEMENT_SCHEMA = z.object({
  elements: z
    .array(
      z.object({
        type: z.string(),
        id: z.number(),
        lat: z.number().optional(),
        lon: z.number().optional(),
        center: z.object({ lat: z.number(), lon: z.number() }).optional(),
        tags: z.record(z.string(), z.string()).optional(),
      }),
    )
    .default([]),
});

/**
 * A ceiling on how much of the world one question may cover.
 *
 * Overpass is a shared volunteer service and a box the size of a continent is
 * a query that costs it minutes. This is roughly a large metropolitan area,
 * which is the scale at which "what is in here" is a real question.
 */
const MAX_AREA_SQ_DEG = 4;

export async function registerAoiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/aoi/infrastructure", async (request, reply) => {
    const query = z
      .object({
        south: z.coerce.number(),
        west: z.coerce.number(),
        north: z.coerce.number(),
        east: z.coerce.number(),
        categories: z.string().optional(),
      })
      .safeParse(request.query);
    if (!query.success) throw badRequest("south, west, north and east are required.");

    const { south, west, north, east } = query.data;
    for (const value of [south, west, north, east]) {
      if (!Number.isFinite(value)) throw badRequest("The box must be numbers.");
    }
    if (south >= north || west >= east) {
      throw badRequest("The box is inside out.");
    }
    if (Math.abs(north - south) * Math.abs(east - west) > MAX_AREA_SQ_DEG) {
      throw badRequest(
        "That area is too large to ask OpenStreetMap about. Draw a smaller one.",
      );
    }

    const wanted = (query.data.categories ?? Object.keys(CATEGORIES).join(","))
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c in CATEGORIES);
    if (wanted.length === 0) throw badRequest("No known categories were asked for.");

    const box = `${south},${west},${north},${east}`;
    const clauses = wanted
      .flatMap((key) => CATEGORIES[key]?.selectors ?? [])
      .map((selector) => `nwr${selector}(${box});`)
      .join("");

    // The timeout is in the query itself: Overpass honours it and gives back a
    // partial answer rather than holding the connection open.
    const ql = `[out:json][timeout:25];(${clauses});out center tags;`;

    try {
      const body = await cached(
        `aoi:${box}:${wanted.join(",")}`,
        30 * 60_000,
        () =>
          getText(OVERPASS, {
            method: "POST",
            body: `data=${encodeURIComponent(ql)}`,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            timeoutMs: 60_000,
          }),
      );

      const parsed = ELEMENT_SCHEMA.parse(JSON.parse(body));
      const features = parsed.elements.flatMap((element) => {
        const lat = element.lat ?? element.center?.lat;
        const lon = element.lon ?? element.center?.lon;
        if (typeof lat !== "number" || typeof lon !== "number") return [];

        const tags = element.tags ?? {};
        const key =
          wanted.find((category) =>
            (CATEGORIES[category]?.selectors ?? []).some((selector) =>
              // The selector is `["k"="v"]` or `["k"]`; match on its key.
              (() => {
                const match = /\["([^"]+)"(?:="([^"]+)")?\]/.exec(selector);
                if (match === null) return false;
                const [, k, v] = match;
                if (k === undefined) return false;
                return v === undefined ? k in tags : tags[k] === v;
              })(),
            ),
          ) ?? "power";

        return [
          {
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: [lon, lat] },
            properties: {
              layer: "aoi",
              id: `${element.type}/${element.id}`,
              label: tags["name"] ?? CATEGORIES[key]?.name ?? "Feature",
              category: CATEGORIES[key]?.name ?? key,
              operator: tags["operator"] ?? null,
              // Every tag that says what the thing is, so the reading is
              // traceable rather than a category badge.
              kind:
                tags["power"] ??
                tags["aeroway"] ??
                tags["military"] ??
                tags["amenity"] ??
                tags["man_made"] ??
                null,
              osm: `${element.type}/${element.id}`,
              url: `https://www.openstreetmap.org/${element.type}/${element.id}`,
              source: "OpenStreetMap contributors (ODbL)",
              colour: CATEGORIES[key]?.colour ?? "#8e8e93",
            },
          },
        ];
      });

      const byCategory: Record<string, number> = {};
      for (const feature of features) {
        const category = String(feature.properties.category);
        byCategory[category] = (byCategory[category] ?? 0) + 1;
      }

      return reply.header("cache-control", "no-store").send({
        type: "FeatureCollection",
        features,
        meta: {
          byCategory,
          box: { south, west, north, east },
          source: "OpenStreetMap via Overpass",
          note: "Crowd-sourced. A feature missing here is not evidence it is not there.",
        },
      });
    } catch (error) {
      return reply.status(200).send({
        type: "FeatureCollection",
        features: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

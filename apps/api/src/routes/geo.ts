import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors.js";

/**
 * Place lookup, forward and reverse.
 *
 * Nominatim is OpenStreetMap's geocoder. It is free, it has no key, and its
 * usage policy asks for one request a second, a real user agent, and no bulk
 * querying — which is exactly why this sits behind the API rather than in the
 * browser. One process here can hold to that rate; a page firing a request per
 * mouse move cannot, and the address that gets blocked is the operator's.
 *
 * Results are cached: the reverse lookup is driven by map movement, and the
 * same rounded coordinate comes back constantly as someone works an area.
 */

const UA = "Scout-OSINT/0.1 (+authorized-engagement-tooling)";
const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60_000;
const MIN_INTERVAL_MS = 1_000;

const cache = new Map<string, { at: number; value: unknown }>();
let lastRequestAt = 0;

/** Serialised, one a second, per the usage policy. */
let queue: Promise<unknown> = Promise.resolve();

async function nominatim(path: string): Promise<unknown> {
  const hit = cache.get(path);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const run = async (): Promise<unknown> => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();

    const response = await fetch(`https://nominatim.openstreetmap.org${path}`, {
      headers: { accept: "application/json", "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Nominatim responded ${response.status}`);
    }
    const value: unknown = await response.json();
    cache.set(path, { at: Date.now(), value });
    return value;
  };

  queue = queue.then(run, run);
  return queue;
}

const searchSchema = z.array(
  z.object({
    display_name: z.string().default(""),
    lat: z.string().default("0"),
    lon: z.string().default("0"),
    type: z.string().optional(),
    boundingbox: z.array(z.string()).optional(),
  }),
);

const reverseSchema = z.object({
  display_name: z.string().optional(),
  address: z.record(z.string(), z.unknown()).optional(),
});

export async function registerGeoRoutes(app: FastifyInstance): Promise<void> {
  app.get("/geo/search", async (request) => {
    const query = z
      .object({ q: z.string().min(1).max(200) })
      .safeParse(request.query);
    if (!query.success) throw badRequest("A place to search for is required.");

    try {
      const raw = await nominatim(
        `/search?format=jsonv2&limit=5&q=${encodeURIComponent(query.data.q)}`,
      );
      const parsed = searchSchema.parse(raw);
      return {
        results: parsed.map((row) => ({
          label: row.display_name,
          lat: Number(row.lat),
          lon: Number(row.lon),
          kind: row.type ?? null,
        })),
      };
    } catch (error) {
      // The search box must not throw a red bar over the map because a
      // geocoder is having a bad minute.
      return {
        results: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  /**
   * Routing, via the OSRM demo server.
   *
   * Keyless and public, which also means it is a shared courtesy service with
   * no uptime promise — so a failure here returns a reason rather than an
   * error page, and the panel says the route could not be planned instead of
   * looking broken.
   *
   * Waypoints arrive as `lon,lat;lon,lat[;...]` and are validated before being
   * put in a URL. This proxies to a fixed host with a fixed path shape; the
   * only thing from the request that reaches it is a list of numbers.
   */
  app.get("/geo/route", async (request) => {
    const query = z
      .object({
        profile: z.enum(["driving", "bike", "foot"]).default("driving"),
        waypoints: z.string().min(3).max(2000),
      })
      .safeParse(request.query);
    if (!query.success) throw badRequest("A profile and waypoints are required.");

    const points = query.data.waypoints.split(";").map((pair) => {
      const parts = pair.split(",");
      return { lon: Number(parts[0]), lat: Number(parts[1]) };
    });

    if (points.length < 2 || points.length > 12) {
      throw badRequest("Give between two and twelve waypoints.");
    }
    for (const { lon, lat } of points) {
      if (
        !Number.isFinite(lon) ||
        !Number.isFinite(lat) ||
        Math.abs(lon) > 180 ||
        Math.abs(lat) > 90
      ) {
        throw badRequest("Waypoints must be lon,lat pairs on Earth.");
      }
    }

    const path = points.map((p) => `${p.lon},${p.lat}`).join(";");
    try {
      const response = await fetch(
        `https://router.project-osrm.org/route/v1/${query.data.profile}/${path}?overview=full&geometries=geojson&steps=true&alternatives=false`,
        {
          headers: { accept: "application/json", "user-agent": UA },
          signal: AbortSignal.timeout(25_000),
        },
      );
      if (!response.ok) {
        return { route: null, error: `Router responded ${response.status}` };
      }

      const data = (await response.json()) as {
        code?: string;
        routes?: Array<{
          distance?: number;
          duration?: number;
          geometry?: { coordinates?: [number, number][] };
          legs?: Array<{
            steps?: Array<{
              name?: string;
              distance?: number;
              maneuver?: { type?: string; modifier?: string };
            }>;
          }>;
        }>;
      };

      const route = data.routes?.[0];
      if (data.code !== "Ok" || route === undefined) {
        return { route: null, error: "No route between those points." };
      }

      return {
        route: {
          distanceM: route.distance ?? 0,
          durationS: route.duration ?? 0,
          coordinates: route.geometry?.coordinates ?? [],
          steps: (route.legs ?? []).flatMap((leg) =>
            (leg.steps ?? [])
              .filter((step) => (step.name ?? "").length > 0)
              .map((step) => ({
                name: step.name ?? "",
                distanceM: step.distance ?? 0,
                maneuver: [step.maneuver?.type, step.maneuver?.modifier]
                  .filter(Boolean)
                  .join(" "),
              })),
          ),
        },
      };
    } catch (error) {
      return {
        route: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  app.get("/geo/reverse", async (request) => {
    const query = z
      .object({ lat: z.coerce.number(), lon: z.coerce.number() })
      .safeParse(request.query);
    if (!query.success) throw badRequest("lat and lon are required.");

    // Rounded to three places — about 100 m. The map moves continuously and
    // the answer does not change between neighbouring pixels, so this is what
    // makes the cache do any work at all.
    const lat = query.data.lat.toFixed(3);
    const lon = query.data.lon.toFixed(3);

    try {
      const raw = await nominatim(
        `/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`,
      );
      const parsed = reverseSchema.parse(raw);
      const address = parsed.address ?? {};
      const parts = ["city", "town", "village", "county", "state", "country"]
        .map((key) => address[key])
        .filter((value): value is string => typeof value === "string");

      return {
        label: parts.slice(0, 2).join(", ") || parsed.display_name || null,
      };
    } catch {
      // Open ocean and unnamed places legitimately have no answer, and so does
      // a failed lookup. Both mean the same thing to the readout: nothing to
      // show.
      return { label: null };
    }
  });
}

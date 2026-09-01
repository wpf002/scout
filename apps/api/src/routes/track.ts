import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { cached } from "../live/cache.js";
import { getJson } from "../live/http.js";

/**
 * Where one aircraft has actually been, and where it says it is going.
 *
 * Both are published facts. The trace is the recorded track from the same
 * ADS-B network Scout already reads; the route is the airline's own filed
 * origin and destination.
 *
 * What this deliberately does not do is predict. Extrapolating a cone forward
 * from heading and speed is what every product does and it would be the only
 * fabricated geometry on Scout's map — rendered with exactly the same
 * authority as the real trace beside it. The published origin-to-destination
 * great circle is the honest substitute and says strictly more.
 *
 * Fetched per selection, never per layer: one aircraft's history is a click,
 * not a background load for nine thousand of them.
 */

const TRACE_SCHEMA = z.object({
  icao: z.string().optional(),
  r: z.string().nullable().optional(),
  t: z.string().nullable().optional(),
  desc: z.string().nullable().optional(),
  timestamp: z.number(),
  /**
   * Positional rows: seconds since `timestamp`, latitude, longitude, altitude,
   * ground speed, track. Altitude is a number or the string "ground".
   */
  trace: z.array(z.array(z.unknown())).default([]),
});

const ROUTE_SCHEMA = z.object({
  response: z.union([
    z.object({
      flightroute: z.object({
        callsign: z.string().optional(),
        airline: z.object({ name: z.string().optional() }).partial().nullable().optional(),
        origin: z
          .object({
            icao_code: z.string().optional(),
            iata_code: z.string().optional(),
            municipality: z.string().nullable().optional(),
            latitude: z.number(),
            longitude: z.number(),
          })
          .nullable()
          .optional(),
        destination: z
          .object({
            icao_code: z.string().optional(),
            iata_code: z.string().optional(),
            municipality: z.string().nullable().optional(),
            latitude: z.number(),
            longitude: z.number(),
          })
          .nullable()
          .optional(),
      }),
    }),
    // "unknown callsign" comes back as a plain string, not an error status.
    z.string(),
  ]),
});

const HEX = /^[0-9a-f]{6}$/i;
const CALLSIGN = /^[A-Z0-9]{2,8}$/;

const TRACE_TTL_MS = 60_000;
const ROUTE_TTL_MS = 24 * 60 * 60_000;

async function loadTrace(hex: string) {
  /*
   * globe.adsb.lol 302s to adsb.lol, and the body is always gzipped. Both are
   * easy to miss: without redirect following the body is an nginx page, and
   * without gzip it is binary. Either parses into nothing.
   */
  const raw = await getJson(
    `https://globe.adsb.lol/data/traces/${hex.slice(-2)}/trace_recent_${hex}.json`,
    { headers: { "accept-encoding": "gzip" }, timeoutMs: 25_000 },
  );
  return TRACE_SCHEMA.parse(raw);
}

async function loadRoute(callsign: string) {
  const raw = await getJson(`https://api.adsbdb.com/v0/callsign/${callsign}`, {
    timeoutMs: 20_000,
  });
  return ROUTE_SCHEMA.parse(raw);
}

export async function registerTrackRoutes(app: FastifyInstance): Promise<void> {
  app.get("/track/:hex", async (request, reply) => {
    const params = z.object({ hex: z.string() }).safeParse(request.params);
    if (!params.success || !HEX.test(params.data.hex)) {
      throw badRequest("A six-character ICAO 24-bit address is required.");
    }
    const hex = params.data.hex.toLowerCase();

    const query = z
      .object({ callsign: z.string().optional() })
      .safeParse(request.query);
    const callsign = (query.success ? (query.data.callsign ?? "") : "")
      .trim()
      .toUpperCase();

    const [traceResult, routeResult] = await Promise.allSettled([
      cached(`trace:${hex}`, TRACE_TTL_MS, () => loadTrace(hex)),
      CALLSIGN.test(callsign)
        ? cached(`route:${callsign}`, ROUTE_TTL_MS, () => loadRoute(callsign))
        : Promise.resolve(null),
    ]);

    // The recorded track.
    let path: Array<[number, number]> = [];
    let altitudes: Array<number | null> = [];
    let since: number | null = null;
    let aircraft: Record<string, unknown> = {};

    if (traceResult.status === "fulfilled") {
      const trace = traceResult.value;
      since = trace.timestamp * 1000;
      aircraft = {
        registration: trace.r ?? null,
        aircraftType: trace.t ?? null,
        model: trace.desc ?? null,
      };

      for (const row of trace.trace) {
        const lat = row[1];
        const lon = row[2];
        if (typeof lat !== "number" || typeof lon !== "number") continue;
        path.push([lon, lat]);
        // "ground" where the aircraft is not airborne, which is a real answer
        // and not a missing one.
        const altitude = row[3];
        altitudes.push(typeof altitude === "number" ? altitude : null);
      }
    }

    // The filed route, if the callsign is known.
    let route: Record<string, unknown> | null = null;
    if (routeResult.status === "fulfilled" && routeResult.value !== null) {
      const response = routeResult.value.response;
      if (typeof response !== "string") {
        const leg = response.flightroute;
        const from = leg.origin;
        const to = leg.destination;
        if (from != null && to != null) {
          route = {
            airline: leg.airline?.name ?? null,
            from: {
              code: from.icao_code ?? from.iata_code ?? null,
              place: from.municipality ?? null,
              lon: from.longitude,
              lat: from.latitude,
            },
            to: {
              code: to.icao_code ?? to.iata_code ?? null,
              place: to.municipality ?? null,
              lon: to.longitude,
              lat: to.latitude,
            },
          };
        }
      }
    }

    if (path.length === 0 && route === null) {
      return reply.status(200).send({
        hex,
        path: [],
        route: null,
        error: "No recorded track or filed route for this aircraft.",
      });
    }

    return reply.header("cache-control", "no-store").send({
      hex,
      aircraft,
      since,
      path,
      altitudes,
      route,
      source: "adsb.lol trace and adsbdb.com route",
      note: "A recorded track and a filed route. Nothing here is predicted.",
    });
  });
}

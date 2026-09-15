import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { cached } from "../live/cache.js";
import { BY_ID, availableLayers, capabilities } from "../live/registry.js";
import { layerHealth } from "../live/warm.js";
import { markets } from "../live/feeds/markets.js";
import { news } from "../live/feeds/news.js";
import { bluetoothSnapshot } from "../live/feeds/bluetooth.js";
import { prisma } from "@scout/db";
import { modelClientFromEnv, parseJsonReply } from "@scout/reason";

/**
 * Whether a url is a public ArcGIS REST service this API will fetch.
 *
 * The client names the service to import, so without this the route is an open
 * proxy: any url, including one on the machine's own network. HTTPS only, and
 * either an arcgis.com host or a host publishing the standard
 * /arcgis/rest/services/ path — which is what an agency's own portal looks
 * like. Hostnames that resolve to the local machine are refused outright.
 */
function isArcGisUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return false;
  // Bare addresses are never a public portal, and are how an SSRF reaches a
  // metadata endpoint or a neighbour on the same subnet.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return false;
  const isArcGisHost = host === "arcgis.com" || host.endsWith(".arcgis.com");
  return isArcGisHost || url.pathname.includes("/arcgis/rest/services/");
}

/** What the client is showing. Bounded so a huge map cannot send a huge prompt. */
const overviewSchema = z.object({
  items: z
    .array(
      z.object({
        label: z.string().max(200),
        detail: z.string().max(200).optional(),
        severity: z.string().max(40).optional(),
        kind: z.string().max(60).optional(),
        at: z.string().max(40).optional(),
      }),
    )
    .max(200),
});

export { clearLiveCache } from "../live/cache.js";

/**
 * How long a cold layer may take before it answers with a reason instead.
 *
 * The dashboard proxies these, and the proxy gives up at thirty seconds. A
 * layer slower than that did not merely feel slow — it reached the browser as a
 * 500 with nothing in it, which is the one outcome this route is written to
 * avoid. Answering below the proxy's ceiling means the operator gets the same
 * "unavailable, and here is why" every other failure produces.
 *
 * The load is not cancelled. It keeps running and fills the cache, so the next
 * request — a few seconds later, when the layer polls again — is served from it.
 */
const LOAD_CEILING_MS = 25_000;

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} did not answer within ${ms / 1000}s`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Live geospatial layers.
 *
 * Each layer is a public feed normalised to GeoJSON so the map handles one
 * shape rather than twenty. Fetching them here rather than from the browser is
 * what makes that possible — most of these send no CORS headers, several are
 * rate limited per address, and one of them answers only over plain HTTP.
 * A shared cache here turns a per-user budget into a per-instance one.
 */

export async function registerLiveRoutes(app: FastifyInstance): Promise<void> {
  /** What layers exist, so the client never hardcodes the roster. */
  app.get("/live/layers", async () => {
    const layers = availableLayers();
    return {
      count: layers.length,
      capabilities: capabilities(),
      layers: layers.map((layer) => ({
        id: layer.id,
        name: layer.name,
        refreshSeconds: Math.round(layer.ttlMs / 1000),
      })),
    };
  });

  /**
   * Whether the layers are actually ready, not merely registered.
   *
   * `/health` answers "the process is up", which is a different question. A
   * freshly started Scout is up and every heavy layer is still cold, so the
   * first switch flipped pays a twenty-five second wait. This is what the start
   * script waits on, and what says which upstream is refusing when one is.
   */
  app.get("/live/ready", async () => {
    const layers = layerHealth();
    const warm = layers.filter((layer) => layer.state === "warm");
    const failed = layers.filter((layer) => layer.state === "failed");
    const cold = layers.filter((layer) => layer.state === "cold");

    return {
      // "Settled", not "ready": a layer whose upstream is down will never be
      // warm, and a start script that waited for warmth alone would wait for
      // ever. Settled means every layer has been tried.
      settled: cold.length === 0,
      ready: cold.length === 0 && failed.length === 0,
      total: layers.length,
      warm: warm.length,
      failed: failed.length,
      cold: cold.length,
      slowest: warm
        .slice()
        .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))
        .slice(0, 3)
        .map((layer) => ({ id: layer.id, ms: layer.ms })),
      unavailable: failed.map((layer) => ({
        id: layer.id,
        name: layer.name,
        error: layer.error,
      })),
      pending: cold.map((layer) => layer.id),
    };
  });

  /**
   * POST /live/overview — a short read of what the live layers are showing.
   *
   * Live alerts are public feed data (quakes, incidents, outages), not case
   * material, so this is outside the scope gate by construction: it never
   * touches the graph and takes no case id. The caller sends the alerts it is
   * already displaying and gets prose back.
   *
   * With no model configured this says so rather than inventing a summary —
   * a blank overview is better than a confident guess about live hazards.
   */
  app.post("/live/overview", async (request, reply) => {
    const body = overviewSchema.parse(request.body);

    let client;
    try {
      client = modelClientFromEnv(process.env);
    } catch (error) {
      return reply.header("cache-control", "no-store").send({
        available: false,
        bullets: [],
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (client === null) {
      return reply.header("cache-control", "no-store").send({
        available: false,
        bullets: [],
        reason: "No model configured. Set REASON_PROVIDER.",
      });
    }
    if (body.items.length === 0) {
      return reply.header("cache-control", "no-store").send({
        available: true,
        bullets: ["Nothing on the active layers right now."],
        model: null,
      });
    }

    const lines = body.items
      .slice(0, 80)
      .map((item) =>
        [item.severity, item.kind, item.label, item.detail, item.at]
          .filter((part) => part !== undefined && part !== "")
          .join(" · "),
      )
      .join("\n");

    try {
      // Every provider in this client is put in JSON mode — the planner needs
      // it — so ask for structured bullets rather than fighting for prose.
      const answer = await client.complete({
        role: "synthesis",
        maxTokens: 400,
        system:
          "You summarise live monitoring alerts for an operator. Use only the lines given. " +
          "Name places and counts. State no cause, forecast or recommendation; if the lines " +
          'do not support a statement, leave it out. Reply as JSON: {"bullets": ["…"]} with ' +
          "at most three entries, each one short sentence.",
        user: `Alerts currently on the map:\n${lines}`,
      });
      const parsed = parseJsonReply(answer.text) as { bullets?: unknown };
      const bullets = Array.isArray(parsed.bullets)
        ? parsed.bullets.filter((b): b is string => typeof b === "string" && b.trim() !== "").slice(0, 3)
        : [];
      if (bullets.length === 0) {
        return reply.header("cache-control", "no-store").send({
          available: false,
          bullets: [],
          reason: "The model returned nothing usable.",
        });
      }
      return reply.header("cache-control", "no-store").send({
        available: true,
        bullets,
        model: answer.model,
      });
    } catch (error) {
      return reply.header("cache-control", "no-store").send({
        available: false,
        bullets: [],
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /**
   * ArcGIS is fronted by CloudFront, which drops a connection often enough that
   * a single attempt is not worth reporting on: a bare fetch throws a raw
   * TypeError, and the error handler turns that into "The request failed. See
   * server logs." — no retry, and nothing the operator can act on. One retry,
   * then a message naming the upstream.
   */
  async function arcgisFetch(url: string, timeoutMs: number): Promise<Response> {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        last = error;
      }
    }
    const reason = last instanceof Error && last.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw badRequest(`ArcGIS ${reason}. It does this intermittently — try again.`);
  }

  /**
   * GET /live/arcgis/search — public feature services matching a query.
   *
   * ArcGIS Online's catalogue is public and keyless. `access:public` is pinned
   * on because most of what the catalogue lists is token-gated at the data
   * layer even when its metadata is visible: without it, half the results
   * import as "Token Required".
   */
  app.get<{ Querystring: Record<string, string | undefined> }>("/live/arcgis/search", async (request, reply) => {
    const q = (request.query["q"] ?? "").trim().slice(0, 200);
    if (q === "") throw badRequest("q is required.");
    const url =
      "https://www.arcgis.com/sharing/rest/search?f=json&num=20&sortField=numViews&sortOrder=desc&q=" +
      encodeURIComponent(`${q} type:"Feature Service" access:public`);

    const response = await arcgisFetch(url, 20_000);
    if (!response.ok) throw badRequest(`ArcGIS answered ${response.status}.`);
    const body = (await response.json()) as { results?: unknown[] };
    const results = (body.results ?? []).flatMap((raw) => {
      const r = raw as Record<string, unknown>;
      const serviceUrl = typeof r["url"] === "string" ? r["url"] : null;
      if (serviceUrl === null || !isArcGisUrl(serviceUrl)) return [];
      return [{
        id: String(r["id"] ?? ""),
        title: String(r["title"] ?? "Untitled"),
        owner: String(r["owner"] ?? ""),
        snippet: typeof r["snippet"] === "string" ? r["snippet"] : null,
        views: typeof r["numViews"] === "number" ? r["numViews"] : 0,
        tags: Array.isArray(r["tags"]) ? (r["tags"] as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 6) : [],
        url: serviceUrl,
      }];
    });
    return reply.header("cache-control", "no-store").send({ count: results.length, results });
  });

  /**
   * GET /live/arcgis/features — one service's features as GeoJSON.
   *
   * The url comes from the client, so it is checked against the same host rule
   * the search applies before anything is fetched: an unchecked url here would
   * turn the API into an open proxy onto whatever the caller names.
   */
  app.get<{ Querystring: Record<string, string | undefined> }>("/live/arcgis/features", async (request, reply) => {
    const target = (request.query["url"] ?? "").trim();
    if (!isArcGisUrl(target)) throw badRequest("url must be a public ArcGIS REST service.");
    const limit = Math.min(Number(request.query["limit"] ?? 2000) || 2000, 4000);

    // A service url may already name a layer ("…/MapServer/1"); otherwise the
    // first layer is the one to ask for.
    const base = /\/\d+$/.test(target) ? target : `${target}/0`;
    const url =
      `${base}/query?f=geojson&where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&resultRecordCount=${limit}`;

    const response = await arcgisFetch(url, 25_000);
    if (!response.ok) throw badRequest(`ArcGIS answered ${response.status}.`);
    const body = (await response.json()) as { type?: string; features?: unknown[]; error?: { message?: string } };
    if (body.error !== undefined) {
      throw badRequest(`ArcGIS refused: ${body.error.message ?? "unknown"}.`);
    }
    return reply.header("cache-control", "no-store").send({
      type: "FeatureCollection",
      features: Array.isArray(body.features) ? body.features : [],
    });
  });

  /**
   * GET /live/aircraft/:hex — who an aircraft on the map is registered to.
   *
   * The live layers already carry `icao24`, and the FAA registry is keyed by
   * the same address, so this is the join that turns a contact on the map into
   * a named owner. Nothing here is scope-gated: the registry is published in
   * full, and this reads one row of it.
   *
   * 404 rather than an empty object when the registry has not been loaded —
   * "no such aircraft" and "pnpm faa:sync has never run" are different answers
   * and the panel says which.
   */
  app.get<{ Params: { hex: string } }>("/live/aircraft/:hex", async (request, reply) => {
    const hex = request.params.hex.trim().toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(hex)) throw badRequest("Expected a six-digit ICAO hex address.");

    const row = await prisma.aircraftRegistration.findFirst({ where: { modeSHex: hex } });
    if (row === null) {
      const loaded = await prisma.aircraftRegistration.count();
      return reply.header("cache-control", "no-store").status(404).send({
        found: false,
        registryLoaded: loaded > 0,
        message: loaded > 0 ? "Not in the US civil registry." : "Registry not loaded. Run: pnpm faa:sync",
      });
    }

    return reply.header("cache-control", "public, max-age=3600").send({
      found: true,
      tail: `N${row.nNumber}`,
      owner: row.ownerName,
      ownerType: row.ownerType,
      aircraft: row.aircraft,
      year: row.yearMfr,
      street: row.street,
      city: row.city,
      state: row.state,
      country: row.country,
      syncedAt: row.syncedAt,
    });
  });

  /**
   * GET /live/bluetooth — radios this machine knows about.
   *
   * Host-side, so it works in Safari and Firefox where Web Bluetooth does not
   * exist at all. Localhost only: this reports the operator's own hardware.
   */
  app.get("/live/bluetooth", async (_request, reply) => {
    return reply.header("cache-control", "no-store").send(await bluetoothSnapshot());
  });

  /** The markets crawl. Not geographic, so not a layer. */
  app.get("/live/markets", async (_request, reply) => {
    try {
      return reply.header("cache-control", "no-store").send(await markets());
    } catch (error) {
      return reply.status(200).send({
        quotes: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /** Wire headlines. Not geographic, so not a layer. */
  app.get("/live/news", async (_request, reply) => {
    try {
      return reply.header("cache-control", "no-store").send(await news());
    } catch (error) {
      return reply.status(200).send({
        headlines: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get("/live/:layer", async (request, reply) => {
    const params = z
      .object({ layer: z.string().min(1) })
      .safeParse(request.params);
    if (!params.success) throw badRequest("A layer is required.");

    const layer = BY_ID.get(params.data.layer);
    if (layer === undefined) {
      throw badRequest(`Unknown layer "${params.data.layer}".`);
    }
    if (layer.requires !== undefined && capabilities()[layer.requires] !== true) {
      throw badRequest(
        `${layer.name} needs ${layer.requires} to be configured on the server.`,
      );
    }

    try {
      const collection = await withTimeout(
        cached(`layer:${layer.id}`, layer.ttlMs, layer.load),
        LOAD_CEILING_MS,
        layer.name,
      );
      return reply.header("cache-control", "no-store").send(collection);
    } catch (error) {
      /*
       * A dead upstream must not take the map down with it. The layer reports
       * empty with a reason at HTTP 200, every other layer keeps drawing, and
       * the rail shows the reason rather than a silent zero — an operator
       * cannot otherwise tell "nothing there" from "the fetch failed".
       */
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(200).send({
        type: "FeatureCollection",
        features: [],
        error: message,
      });
    }
  });
}

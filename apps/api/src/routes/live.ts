import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { cached } from "../live/cache.js";
import { BY_ID, availableLayers, capabilities } from "../live/registry.js";
import { layerHealth } from "../live/warm.js";
import { markets } from "../live/feeds/markets.js";
import { news } from "../live/feeds/news.js";
import { modelClientFromEnv, parseJsonReply } from "@scout/reason";

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

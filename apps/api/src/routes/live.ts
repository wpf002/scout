import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../errors.js";
import { cached } from "../live/cache.js";
import { BY_ID, availableLayers, capabilities } from "../live/registry.js";
import { markets } from "../live/feeds/markets.js";
import { news } from "../live/feeds/news.js";

export { clearLiveCache } from "../live/cache.js";

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
      const collection = await cached(`layer:${layer.id}`, layer.ttlMs, layer.load);
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

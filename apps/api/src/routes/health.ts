import type { FastifyInstance } from "fastify";
import { SOURCES, hasKey } from "@scout/sources";
import { prisma } from "@scout/db";

export async function registerHealthRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/health", async (_request, reply) => {
    let database: "up" | "down" = "down";
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = "up";
    } catch {
      // Reported, not thrown. /health answering is more useful than /health
      // 500ing when Postgres is the thing that is down.
      database = "down";
    }

    const keyed = SOURCES.filter((s) => s.mode === "api" && hasKey(s));

    reply.status(database === "up" ? 200 : 503);
    return {
      status: database === "up" ? "ok" : "degraded",
      database,
      sources: {
        total: SOURCES.length,
        api: SOURCES.filter((s) => s.mode === "api").length,
        keyed: keyed.length,
        // Named so an operator can see what is live without dumping any key.
        keyedSourceIds: keyed.map((s) => s.id),
      },
    };
  });
}

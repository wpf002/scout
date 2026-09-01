import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { registerErrorHandler } from "./errors.js";
import { registerAuth } from "./auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerQueryRoutes } from "./routes/query.js";
import { registerRunRoutes } from "./routes/run.js";
import { registerTileRoutes } from "./routes/tiles.js";
import { registerLiveRoutes } from "./routes/live.js";
import { registerGeoRoutes } from "./routes/geo.js";
import { registerTrackRoutes } from "./routes/track.js";
import { registerAoiRoutes } from "./routes/aoi.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerCaseRoutes } from "./routes/cases.js";
import { registerScopedRoutes } from "./routes/scoped.js";
import { registerInfraRoutes } from "./routes/infra.js";
import { registerDatasetRoutes } from "./routes/datasets.js";
import { registerReportRoutes } from "./routes/report.js";
import { registerRetentionRoutes } from "./routes/retention.js";
import { registerGraphRoutes } from "./routes/graph.js";
import { registerMonitorRoutes } from "./routes/monitors.js";
import { config } from "./config.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level:
        config.NODE_ENV === "test"
          ? "silent"
          : config.NODE_ENV === "production"
            ? "info"
            : "debug",
      // Subject terms and keys travel in bodies and headers. Neither belongs
      // in a log line, so requests are logged by route and status only.
      redact: {
        paths: [
          'req.headers["hibp-api-key"]',
          'req.headers["x-api-key"]',
          "req.headers.authorization",
          "req.body",
        ],
        remove: true,
      },
    },
    // Subject terms must not end up in URLs; bodies stay modest.
    bodyLimit: 1_048_576,
  });

  const origins = config.SCOUT_WEB_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  await app.register(cors, {
    origin: origins,
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

  registerErrorHandler(app);
  await registerAuth(app);

  await registerHealthRoutes(app);
  await registerQueryRoutes(app);
  await registerRunRoutes(app);
  await registerTileRoutes(app);
  await registerLiveRoutes(app);
  await registerGeoRoutes(app);
  await registerTrackRoutes(app);
  await registerAoiRoutes(app);
  await registerHistoryRoutes(app);
  await registerCaseRoutes(app);
  await registerScopedRoutes(app);
  await registerInfraRoutes(app);
  await registerDatasetRoutes(app);
  await registerReportRoutes(app);
  await registerRetentionRoutes(app);
  await registerGraphRoutes(app);
  await registerMonitorRoutes(app);

  return app;
}

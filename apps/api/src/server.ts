import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { registerErrorHandler } from "./errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerQueryRoutes } from "./routes/query.js";
import { registerCaseRoutes } from "./routes/cases.js";
import { registerScopedRoutes } from "./routes/scoped.js";
import { registerInfraRoutes } from "./routes/infra.js";
import { registerDatasetRoutes } from "./routes/datasets.js";
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

  await registerHealthRoutes(app);
  await registerQueryRoutes(app);
  await registerCaseRoutes(app);
  await registerScopedRoutes(app);
  await registerInfraRoutes(app);
  await registerDatasetRoutes(app);

  return app;
}

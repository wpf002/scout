import { buildServer } from "./server.js";
import { config } from "./config.js";
import { prisma } from "@scout/db";
import { startMonitorScheduler } from "./monitor/scheduler.js";
import type { MonitorScheduler } from "./monitor/scheduler.js";

async function main(): Promise<void> {
  const app = await buildServer();

  // Deliberately started here rather than in `buildServer()`: the test suite
  // builds a server per file, and none of them should acquire a timer that
  // makes outbound requests.
  let scheduler: MonitorScheduler | null = null;
  if (config.SCOUT_MONITOR_TICK_SECONDS !== undefined) {
    scheduler = startMonitorScheduler({
      log: app.log,
      intervalSeconds: config.SCOUT_MONITOR_TICK_SECONDS,
      operator: config.SCOUT_OPERATOR,
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    scheduler?.stop();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((error: unknown) => {
  console.error("Scout API failed to start:", error);
  process.exit(1);
});

import { buildServer } from "./server.js";
import { config } from "./config.js";
import { prisma } from "@scout/db";
import { startMonitorScheduler } from "./monitor/scheduler.js";
import type { MonitorScheduler } from "./monitor/scheduler.js";
import { keepWarm } from "./live/warm.js";
import { agentTick } from "./agent/index.js";

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

  // The agent's observe pass, on the same scheduler with the same guards.
  // Off unless SCOUT_AGENT_TICK_SECONDS is set: a process that starts
  // watching and proposing on a timer is something you turned on.
  let agent: MonitorScheduler | null = null;
  const agentSeconds = Number(process.env["SCOUT_AGENT_TICK_SECONDS"]);
  if (Number.isInteger(agentSeconds) && agentSeconds >= 5) {
    agent = startMonitorScheduler({
      log: app.log,
      intervalSeconds: agentSeconds,
      operator: config.SCOUT_OPERATOR,
      sweep: (operator, now) => agentTick(operator, now),
    });
  }

  // Same reasoning as the scheduler above: a timer that makes outbound
  // requests belongs to the running server, not to every server a test builds.
  const stopWarming = keepWarm((id, ms, ok) => {
    app.log.debug({ layer: id, ms, ok }, "warmed live layer");
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    stopWarming();
    scheduler?.stop();
    agent?.stop();
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

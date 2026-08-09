import type { FastifyBaseLogger } from "fastify";
import { runDueMonitors } from "./run.js";
import { logEvent } from "../observability.js";

/**
 * The in-process monitor ticker.
 *
 * **This is not a job queue and does not pretend to be one.** The roadmap's
 * defer criterion for Redis and a real queue — sustained load that in-memory
 * caching and per-source token buckets cannot absorb — is still unmet, and
 * building one on speculation would be the kind of infrastructure that exists
 * to look finished. What is genuinely missing is smaller: without *something*
 * calling the sweep, a monitor only ever runs when a human presses a button,
 * which makes "standing watch" a promise nothing keeps.
 *
 * So this is a timer. It has no retries, no backoff, no persistence across a
 * restart, and no distribution. What it does have is the two properties that
 * make it safe to leave running:
 *
 *   - **Non-overlapping.** A tick that arrives while the previous sweep is
 *     still going is skipped and counted, not queued behind it.
 *   - **Safe alongside anything else.** Every monitor is claimed with a
 *     conditional update before it runs, so this ticker, an external cron, and
 *     a second API instance can all be pointed at the same database without
 *     double-running a monitor. That is what makes it correct to enable on one
 *     replica and forget about it.
 *
 * Off unless `SCOUT_MONITOR_TICK_SECONDS` is set, because a process that
 * quietly starts making outbound requests on a timer should be something you
 * turned on.
 */
export interface MonitorScheduler {
  stop: () => void;
  /**
   * Runs a sweep now, honouring the same non-overlap guard. Reports which of
   * the two happened, so the guard is observable rather than something a test
   * has to infer from side effects it does not exclusively cause.
   */
  tick: () => Promise<"ran" | "skipped" | "failed">;
}

export function startMonitorScheduler({
  log,
  intervalSeconds,
  operator,
  sweep = runDueMonitors,
}: {
  log: FastifyBaseLogger;
  intervalSeconds: number;
  operator: string;
  /**
   * The sweep to run. Injectable so a test can make it throw — spying on an
   * ES module binding is not reliable, and "the timer survives a sweep that
   * throws" is the one property here worth proving rather than asserting.
   */
  sweep?: (operator: string, now: number) => Promise<{
    checked: number;
    ran: number;
  }>;
}): MonitorScheduler {
  let running = false;
  let skipped = 0;

  const tick = async (): Promise<"ran" | "skipped" | "failed"> => {
    if (running) {
      // A sweep that takes longer than the interval must not stack. Counting
      // the skip means a scheduler that is permanently behind is visible in
      // the logs rather than silently keeping up.
      skipped += 1;
      logEvent(log, "monitor.tick.skipped", { consecutiveSkips: skipped });
      return "skipped";
    }

    // Set before the first `await`, which is what makes the guard hold: a
    // second tick entering this function cannot get past the check above.
    running = true;
    try {
      const result = await sweep(operator, Date.now());
      skipped = 0;
      if (result.ran > 0) {
        logEvent(log, "monitor.tick", {
          checked: result.checked,
          ran: result.ran,
        });
      }
      return "ran";
    } catch (error) {
      // A failed sweep must not kill the timer — the next one may well work.
      logEvent(log, "monitor.tick.failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return "failed";
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalSeconds * 1000);
  // Never hold the process open on the timer's account.
  timer.unref();

  logEvent(log, "monitor.scheduler.started", { intervalSeconds });

  return { stop: () => clearInterval(timer), tick };
}

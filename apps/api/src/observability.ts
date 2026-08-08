import type { FastifyBaseLogger } from "fastify";

/**
 * Structured events worth watching in production.
 *
 * A stable `event` field means these can be alerted on without parsing prose,
 * and the set is deliberately small: the things that matter operationally are
 * refusals, upstream failures, and anything touching authentication. Metrics
 * and tracing stay unbuilt until traffic warrants them — the roadmap's defer
 * criterion, and unmet.
 */
export type ScoutEvent =
  /** The scope gate refused a query. The signal that matters most. */
  | "scope.denied"
  /** An upstream call failed. Distinguishes "provider down" from "no results". */
  | "upstream.failed"
  /** A source could not run because it has no key. */
  | "source.inert"
  /** A batch sweep skipped a source, with the reason. */
  | "sweep.excluded"
  /** Case contents left the tool. */
  | "case.exported"
  /** Investigative content was purged. */
  | "case.purged"
  /** A request failed authentication. */
  | "auth.rejected";

/**
 * Emits a structured event.
 *
 * Fields must never carry a subject term, a key, or credential material — the
 * whole point of routing through one helper is that there is one place to
 * check that. Source ids, reasons and counts are safe; the thing being looked
 * up is not.
 */
export function logEvent(
  logger: FastifyBaseLogger,
  event: ScoutEvent,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  const level = event === "upstream.failed" || event === "auth.rejected"
    ? "warn"
    : event === "scope.denied"
      ? "warn"
      : "info";
  logger[level]({ event, ...fields }, event);
}

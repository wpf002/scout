/**
 * Stops calling a source that has told us to stop calling it.
 *
 * Two things kept showing up as red errors on every single run: crt.sh, which
 * has been returning 502s for days, and HackerTarget, whose free quota is per
 * address and is spent by mid-session. Neither is a broken source and neither
 * is a finding. But each run re-issued the request, waited for it, and painted
 * the row red — which trains an investigator to ignore red rows, and that is a
 * real cost, because sometimes a red row means something.
 *
 * So a source that fails in a way that will not resolve on the next request
 * gets a cooldown. During it the source reports `inert` — the same reported,
 * non-alarming state as a missing key — with the reason and the time it will
 * be tried again. Nothing is hidden; it just stops pretending each run is a
 * fresh failure.
 *
 * Deliberately in-process and unpersisted. A restart clears it, which is the
 * right behaviour: restarting is exactly when an operator wants to retry
 * everything.
 */

export type TripReason = "quota" | "upstream";

export interface Trip {
  reason: TripReason;
  message: string;
  /** Epoch ms after which the source is tried again. */
  until: number;
}

/**
 * A quota is spent for a while — an hour is the shortest wait that stands a
 * chance of a different answer, and re-asking sooner only burns the next
 * allowance the moment it lands.
 */
const QUOTA_COOLDOWN_MS = 60 * 60 * 1000;

/** An outage may clear at any time, so this is short. */
const UPSTREAM_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * How many consecutive failures before an outage is treated as one.
 *
 * Not one: a single failure is noise, and tripping on it would silence a
 * source that was fine a second later.
 */
const FAILURES_BEFORE_TRIP = 3;

const trips = new Map<string, Trip>();
const consecutiveFailures = new Map<string, number>();

/** Quota and rate-limit signatures, which are not outages and need longer. */
const QUOTA_PATTERN =
  /quota|count exceeded|rate limit|rate-limited|too many requests|\b429\b/i;

export function classifyFailure(message: string): TripReason {
  return QUOTA_PATTERN.test(message) ? "quota" : "upstream";
}

/**
 * The active cooldown for a source, or null.
 *
 * Expired trips are cleared on read rather than by a timer, so there is no
 * background work and no way for a stale entry to outlive its own deadline.
 */
export function activeTrip(sourceId: string, now = Date.now()): Trip | null {
  const trip = trips.get(sourceId);
  if (trip === undefined) return null;
  if (trip.until <= now) {
    trips.delete(sourceId);
    consecutiveFailures.delete(sourceId);
    return null;
  }
  return trip;
}

/** Records a failure, tripping the breaker when the pattern warrants it. */
export function recordFailure(
  sourceId: string,
  message: string,
  now = Date.now(),
): Trip | null {
  const reason = classifyFailure(message);

  // A quota refusal is unambiguous and self-reported — there is nothing to be
  // confirmed by asking twice more.
  if (reason === "quota") {
    const trip: Trip = {
      reason,
      message,
      until: now + QUOTA_COOLDOWN_MS,
    };
    trips.set(sourceId, trip);
    return trip;
  }

  const failures = (consecutiveFailures.get(sourceId) ?? 0) + 1;
  consecutiveFailures.set(sourceId, failures);
  if (failures < FAILURES_BEFORE_TRIP) return null;

  const trip: Trip = { reason, message, until: now + UPSTREAM_COOLDOWN_MS };
  trips.set(sourceId, trip);
  return trip;
}

/** A success clears everything — the source is working again. */
export function recordSuccess(sourceId: string): void {
  trips.delete(sourceId);
  consecutiveFailures.delete(sourceId);
}

/** For tests, and for an operator who wants everything retried now. */
export function clearBreakers(): void {
  trips.clear();
  consecutiveFailures.clear();
}

/** Human-readable cooldown message, naming when it will be tried again. */
export function tripMessage(
  sourceName: string,
  trip: Trip,
  now = Date.now(),
): string {
  const minutes = Math.max(1, Math.ceil((trip.until - now) / 60_000));
  const cause =
    trip.reason === "quota"
      ? "has spent its free quota"
      : "has been failing";
  return `${sourceName} ${cause}. Not retried for ${minutes} min. Last response: ${trip.message}`;
}

/**
 * Per-source rate limiting: a token bucket for each upstream.
 *
 * The point is not to protect Scout — it is to stay inside the quota an
 * investigator is paying for, and to avoid getting a key banned mid-engagement.
 * Limits are per source because the upstreams have nothing to do with each
 * other.
 *
 * When no token is available within `maxWaitMs` the caller is told so and
 * degrades to a reported `rate-limited` result. It never spins, and it never
 * silently hammers the upstream.
 */
export interface BucketConfig {
  /** Maximum burst. */
  capacity: number;
  /** Sustained rate. */
  refillPerSecond: number;
  /** How long a caller will wait for a token before giving up. */
  maxWaitMs?: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
  config: Required<BucketConfig>;
}

const DEFAULT: Required<BucketConfig> = {
  capacity: 5,
  refillPerSecond: 1,
  maxWaitMs: 5_000,
};

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly configs: Record<string, BucketConfig>;

  constructor(configs: Record<string, BucketConfig> = {}) {
    this.configs = configs;
  }

  private bucketFor(sourceId: string, now: number): Bucket {
    let bucket = this.buckets.get(sourceId);
    if (bucket === undefined) {
      const config = { ...DEFAULT, ...(this.configs[sourceId] ?? {}) };
      bucket = { tokens: config.capacity, lastRefill: now, config };
      this.buckets.set(sourceId, bucket);
    }
    return bucket;
  }

  private refill(bucket: Bucket, now: number): void {
    const elapsedSec = Math.max(0, now - bucket.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    bucket.tokens = Math.min(
      bucket.config.capacity,
      bucket.tokens + elapsedSec * bucket.config.refillPerSecond,
    );
    bucket.lastRefill = now;
  }

  /** Takes a token if one is free right now. Never blocks. */
  tryAcquire(sourceId: string, now: number = Date.now()): boolean {
    const bucket = this.bucketFor(sourceId, now);
    this.refill(bucket, now);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * Waits for a token, up to the source's `maxWaitMs`.
   * @returns true if a token was acquired, false if the wait was exhausted.
   */
  async acquire(sourceId: string): Promise<boolean> {
    const bucket = this.bucketFor(sourceId, Date.now());
    const deadline = Date.now() + bucket.config.maxWaitMs;

    for (;;) {
      if (this.tryAcquire(sourceId)) return true;
      if (Date.now() >= deadline) return false;

      // Sleep just long enough for the next token, capped so we re-check
      // regularly rather than oversleeping past the deadline.
      const msPerToken = 1000 / bucket.config.refillPerSecond;
      const wait = Math.min(msPerToken, deadline - Date.now(), 250);
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, wait)));
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Conservative defaults. Free tiers are the constraint that matters: a paid
 * plan can afford a burst, a free key gets suspended for one.
 */
export const infraRateLimiter = new RateLimiter({
  // crt.sh is free and community-run — be a good citizen.
  crtsh: { capacity: 2, refillPerSecond: 0.5, maxWaitMs: 8_000 },
  shodan: { capacity: 3, refillPerSecond: 1 },
  censys: { capacity: 3, refillPerSecond: 0.4 },
  securitytrails: { capacity: 3, refillPerSecond: 0.5 },
});

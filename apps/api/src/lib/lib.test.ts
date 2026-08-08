import { describe, expect, it } from "vitest";
import { TtlCache, responseCacheKey } from "./cache.js";
import { RateLimiter } from "./ratelimit.js";

describe("TtlCache", () => {
  it("returns a stored value before it expires", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    cache.set("a", "value", 0);
    expect(cache.get("a", 500)).toBe("value");
  });

  it("expires a value and drops it", () => {
    const cache = new TtlCache<string>({ ttlMs: 1000 });
    cache.set("a", "value", 0);
    expect(cache.get("a", 1001)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entry once full", () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2 });
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    cache.set("c", 3, 0);
    expect(cache.size).toBe(2);
    expect(cache.get("a", 1)).toBeUndefined();
    expect(cache.get("c", 1)).toBe(3);
  });

  it("treats a read as recent use, so the idle key is evicted first", () => {
    const cache = new TtlCache<number>({ ttlMs: 10_000, maxEntries: 2 });
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    cache.get("a", 1);
    cache.set("c", 3, 1);
    expect(cache.get("a", 2)).toBe(1);
    expect(cache.get("b", 2)).toBeUndefined();
  });
});

describe("responseCacheKey", () => {
  it("is case- and whitespace-insensitive on the subject", () => {
    expect(responseCacheKey("crtsh", "domain", "  Example.COM ")).toBe(
      responseCacheKey("crtsh", "domain", "example.com"),
    );
  });

  it("separates sources and subject kinds", () => {
    const keys = new Set([
      responseCacheKey("crtsh", "domain", "example.com"),
      responseCacheKey("shodan", "domain", "example.com"),
      responseCacheKey("crtsh", "ip", "example.com"),
    ]);
    expect(keys.size).toBe(3);
  });
});

describe("RateLimiter", () => {
  it("allows a burst up to capacity, then refuses", () => {
    const limiter = new RateLimiter({ demo: { capacity: 2, refillPerSecond: 1 } });
    expect(limiter.tryAcquire("demo", 0)).toBe(true);
    expect(limiter.tryAcquire("demo", 0)).toBe(true);
    expect(limiter.tryAcquire("demo", 0)).toBe(false);
  });

  it("refills over time at the configured rate", () => {
    const limiter = new RateLimiter({ demo: { capacity: 2, refillPerSecond: 1 } });
    limiter.tryAcquire("demo", 0);
    limiter.tryAcquire("demo", 0);
    expect(limiter.tryAcquire("demo", 500)).toBe(false);
    expect(limiter.tryAcquire("demo", 1000)).toBe(true);
  });

  it("never refills past capacity", () => {
    const limiter = new RateLimiter({ demo: { capacity: 2, refillPerSecond: 5 } });
    limiter.tryAcquire("demo", 0);
    limiter.tryAcquire("demo", 0);
    expect(limiter.tryAcquire("demo", 60_000)).toBe(true);
    expect(limiter.tryAcquire("demo", 60_000)).toBe(true);
    expect(limiter.tryAcquire("demo", 60_000)).toBe(false);
  });

  it("keeps buckets independent per source", () => {
    const limiter = new RateLimiter({
      a: { capacity: 1, refillPerSecond: 1 },
      b: { capacity: 1, refillPerSecond: 1 },
    });
    expect(limiter.tryAcquire("a", 0)).toBe(true);
    expect(limiter.tryAcquire("a", 0)).toBe(false);
    // Exhausting one upstream must not starve an unrelated one.
    expect(limiter.tryAcquire("b", 0)).toBe(true);
  });

  it("gives up rather than waiting forever when the bucket stays empty", async () => {
    const limiter = new RateLimiter({
      slow: { capacity: 1, refillPerSecond: 0.001, maxWaitMs: 60 },
    });
    expect(await limiter.acquire("slow")).toBe(true);
    const startedAt = Date.now();
    expect(await limiter.acquire("slow")).toBe(false);
    // Bounded wait — the caller degrades to a reported rate-limit, not a hang.
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

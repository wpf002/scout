import { beforeEach, describe, expect, it, vi } from "vitest";

import { cached, clearLiveCache } from "./cache.js";

describe("cached", () => {
  beforeEach(() => clearLiveCache());

  it("runs one load for concurrent callers of a cold key", async () => {
    // The reason this matters is not the wasted work. Several of these
    // upstreams are rate limited per address, so the duplicate call can be the
    // one that gets the address refused.
    let runs = 0;
    const load = async (): Promise<number> => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return runs;
    };

    const answers = await Promise.all([
      cached("k", 60_000, load),
      cached("k", 60_000, load),
      cached("k", 60_000, load),
    ]);

    expect(runs).toBe(1);
    expect(answers).toEqual([1, 1, 1]);
  });

  it("serves the cached value inside the TTL", async () => {
    const load = vi.fn(async () => "first");
    expect(await cached("k", 60_000, load)).toBe("first");
    expect(await cached("k", 60_000, load)).toBe("first");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads once the TTL has passed", async () => {
    let n = 0;
    const load = async (): Promise<number> => (n += 1);
    expect(await cached("k", 0, load)).toBe(1);
    expect(await cached("k", 0, load)).toBe(2);
  });

  it("gives every joined caller the stale value when a refresh fails", async () => {
    await cached("k", 0, async () => "good");

    const failing = async (): Promise<string> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("upstream down");
    };

    // Joining an in-flight load must not turn "stale but correct" into an
    // error for everyone except the caller who started it.
    const answers = await Promise.all([
      cached("k", 0, failing),
      cached("k", 0, failing),
    ]);
    expect(answers).toEqual(["good", "good"]);
  });

  it("throws when a cold load fails and there is nothing to fall back to", async () => {
    await expect(
      cached("k", 60_000, async () => {
        throw new Error("upstream down");
      }),
    ).rejects.toThrow("upstream down");
  });

  it("does not wedge a key after a failure", async () => {
    await expect(
      cached("k", 60_000, async () => {
        throw new Error("first attempt");
      }),
    ).rejects.toThrow("first attempt");

    // A failed load that left its promise in the in-flight map would hand this
    // caller the same rejection forever.
    expect(await cached("k", 60_000, async () => "recovered")).toBe("recovered");
  });
});

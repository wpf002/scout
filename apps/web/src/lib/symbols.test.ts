import { describe, expect, it } from "vitest";

/**
 * The SDF alpha encoding, pinned.
 *
 * These three constants are the difference between an aircraft and a blob the
 * size of a city, and nothing on screen explains which one you have — a
 * wrongly-encoded field renders as a plausible-looking smear. The formula is
 * TinySDF's, which is what MapLibre reads.
 */

const RADIUS = 8;
const EDGE_CUTOFF = 0.25;

function alphaFor(nearest: number, inside: boolean): number {
  const distanceOutside = inside ? -nearest : nearest;
  return Math.max(
    0,
    Math.min(255, Math.round(255 - 255 * (distanceOutside / RADIUS + EDGE_CUTOFF))),
  );
}

describe("SDF alpha encoding", () => {
  it("puts the shape edge at 191, not at the midpoint", () => {
    // The bug this catches: encoding the edge at 128 makes everything from
    // 128 to 191 read as interior, dilating every symbol enormously.
    expect(alphaFor(0, true)).toBe(191);
    expect(alphaFor(0, false)).toBe(191);
    expect(alphaFor(0, true)).not.toBe(128);
  });

  it("saturates two pixels inside the shape", () => {
    expect(alphaFor(2, true)).toBe(255);
    expect(alphaFor(RADIUS, true)).toBe(255);
    expect(alphaFor(RADIUS * 2, true)).toBe(255);
  });

  it("falls to zero six pixels outside the shape", () => {
    expect(alphaFor(6, false)).toBe(0);
    expect(alphaFor(RADIUS, false)).toBe(0);
    expect(alphaFor(RADIUS * 2, false)).toBe(0);
  });

  it("decreases monotonically across the unsaturated band", () => {
    /*
     * The band is narrow and asymmetric, which is the point of the cutoff:
     * with an edge at 0.25 the field saturates two pixels inside the shape but
     * runs six pixels out from it. Sampling outside that band gets 255 on both
     * sides and says nothing — this test asserts the ramp, not the clamp.
     */
    const ramp = [
      alphaFor(2, true),
      alphaFor(1, true),
      alphaFor(0, true),
      alphaFor(2, false),
      alphaFor(4, false),
    ];
    for (let i = 1; i < ramp.length; i += 1) {
      expect(ramp[i]).toBeLessThan(ramp[i - 1] as number);
    }
  });

  it("stays inside the byte range at every distance", () => {
    for (const nearest of [0, 1, 4, 8, 20, 64]) {
      for (const inside of [true, false]) {
        const alpha = alphaFor(nearest, inside);
        expect(alpha).toBeGreaterThanOrEqual(0);
        expect(alpha).toBeLessThanOrEqual(255);
        expect(Number.isInteger(alpha)).toBe(true);
      }
    }
  });
});

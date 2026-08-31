import { describe, expect, it } from "vitest";
import { nightPolygon } from "./terminator.js";

/**
 * The terminator is checked against astronomy that is not in dispute: where
 * the sun is overhead at the solstices and equinoxes, and which pole is dark
 * when. A sign error here inverts day and night over half the planet and looks
 * entirely plausible on screen.
 */

/** Solar noon at Greenwich — the sun is over longitude 0. */
const noonUtc = (month: number, day: number) =>
  new Date(Date.UTC(2026, month - 1, day, 12, 0, 0));

function inside(ring: number[][], lon: number, lat: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    const [ax, ay] = a as [number, number];
    const [bx, by] = b as [number, number];
    if (ay > lat !== by > lat && lon < ((bx - ax) * (lat - ay)) / (by - ay) + ax) {
      hit = !hit;
    }
  }
  return hit;
}

describe("nightPolygon", () => {
  it("closes on itself", () => {
    const ring = nightPolygon(noonUtc(3, 20));
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it("stays within valid coordinates", () => {
    for (const month of [1, 4, 7, 10]) {
      for (const [lon, lat] of nightPolygon(noonUtc(month, 15))) {
        expect(lon).toBeGreaterThanOrEqual(-180);
        expect(lon).toBeLessThanOrEqual(180);
        expect(lat).toBeGreaterThanOrEqual(-90);
        expect(lat).toBeLessThanOrEqual(90);
      }
    }
  });

  it("darkens the south pole in the northern summer", () => {
    // Antarctica is in polar night at the June solstice.
    const ring = nightPolygon(noonUtc(6, 21));
    expect(inside(ring, 0, -85)).toBe(true);
    expect(inside(ring, 0, 85)).toBe(false);
  });

  it("darkens the north pole in the northern winter", () => {
    const ring = nightPolygon(noonUtc(12, 21));
    expect(inside(ring, 0, 85)).toBe(true);
    expect(inside(ring, 0, -85)).toBe(false);
  });

  it("puts midnight in darkness and noon in daylight", () => {
    // At 12:00 UTC the sun is over Greenwich, so the antipode is in night.
    // Sampled at 179 rather than 180: the ring is closed along that meridian,
    // and a point-in-polygon test exactly on an edge is a coin toss.
    const ring = nightPolygon(noonUtc(6, 21));
    expect(inside(ring, 179, 0)).toBe(true);
    expect(inside(ring, 0, 0)).toBe(false);
  });

  it("stays finite at the equinox, where the terminator runs pole to pole", () => {
    // Declination passes through zero here, and the latitude of the
    // terminator is an arctangent of a division by it. The shape degenerates;
    // it must not produce NaN and take the whole layer down with it.
    for (const ring of [nightPolygon(noonUtc(3, 20)), nightPolygon(noonUtc(9, 22))]) {
      for (const [lon, lat] of ring) {
        expect(Number.isFinite(lon)).toBe(true);
        expect(Number.isFinite(lat)).toBe(true);
      }
    }
  });

  it("follows the clock rather than standing still", () => {
    const noon = nightPolygon(new Date(Date.UTC(2026, 5, 21, 12)));
    const midnight = nightPolygon(new Date(Date.UTC(2026, 5, 21, 0)));
    // Twelve hours apart, the same meridian swaps from day to night.
    expect(inside(noon, 0, 0)).toBe(false);
    expect(inside(midnight, 0, 0)).toBe(true);
  });
});

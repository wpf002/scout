import { describe, expect, it } from "vitest";
import {
  area,
  build,
  circle,
  distance,
  formatArea,
  formatDistance,
} from "./measure.js";

/**
 * These are the numbers an operator reads off the screen and acts on, so they
 * are checked against known distances rather than against themselves.
 */
describe("distance", () => {
  it("measures a degree of latitude as about 111 km", () => {
    const metres = distance({ lon: 0, lat: 0 }, { lon: 0, lat: 1 });
    expect(metres / 1000).toBeCloseTo(111.19, 1);
  });

  it("matches the published London to New York great circle", () => {
    // 5,570 km is the commonly cited figure between the two city centres.
    const metres = distance(
      { lon: -0.1276, lat: 51.5072 },
      { lon: -74.006, lat: 40.7128 },
    );
    expect(metres / 1000).toBeGreaterThan(5560);
    expect(metres / 1000).toBeLessThan(5580);
  });

  it("shrinks a degree of longitude toward the pole", () => {
    // The failure this catches is treating the sphere as a plane, which is
    // exactly the error that makes a polar radius wrong.
    const equator = distance({ lon: 0, lat: 0 }, { lon: 1, lat: 0 });
    const high = distance({ lon: 0, lat: 60 }, { lon: 1, lat: 60 });
    expect(high / equator).toBeCloseTo(0.5, 2);
  });

  it("is symmetric and zero at a point", () => {
    const a = { lon: 12, lat: -30 };
    const b = { lon: -45, lat: 66 };
    expect(distance(a, b)).toBeCloseTo(distance(b, a), 6);
    expect(distance(a, a)).toBeCloseTo(0, 6);
  });
});

describe("area", () => {
  it("measures a one-degree square at the equator", () => {
    const ring = [
      { lon: 0, lat: 0 },
      { lon: 1, lat: 0 },
      { lon: 1, lat: 1 },
      { lon: 0, lat: 1 },
    ];
    // About 111 km on a side.
    expect(area(ring) / 1_000_000).toBeGreaterThan(12_000);
    expect(area(ring) / 1_000_000).toBeLessThan(12_400);
  });

  it("does not depend on winding order", () => {
    const ring = [
      { lon: 0, lat: 0 },
      { lon: 2, lat: 0 },
      { lon: 2, lat: 2 },
      { lon: 0, lat: 2 },
    ];
    expect(area(ring)).toBeCloseTo(area([...ring].reverse()), 0);
  });

  it("is zero for anything that cannot enclose", () => {
    expect(area([])).toBe(0);
    expect(area([{ lon: 0, lat: 0 }])).toBe(0);
    expect(area([{ lon: 0, lat: 0 }, { lon: 1, lat: 1 }])).toBe(0);
  });
});

describe("circle", () => {
  it("puts every vertex at the requested radius", () => {
    const centre = { lon: -3, lat: 55 };
    const ring = circle(centre, 50_000, 32);
    for (const vertex of ring) {
      expect(distance(centre, vertex) / 1000).toBeCloseTo(50, 1);
    }
  });

  it("closes on itself", () => {
    const ring = circle({ lon: 10, lat: 10 }, 100_000, 16);
    expect(ring[0]?.lat).toBeCloseTo(ring[ring.length - 1]?.lat ?? 0, 9);
  });

  it("keeps longitudes in range when it crosses the antimeridian", () => {
    // A circle drawn at 179E wraps. Emitting 181 would put half the shape off
    // the map rather than round the back of it.
    for (const vertex of circle({ lon: 179.5, lat: 0 }, 200_000, 64)) {
      expect(vertex.lon).toBeGreaterThanOrEqual(-180);
      expect(vertex.lon).toBeLessThanOrEqual(180);
    }
  });
});

describe("build", () => {
  it("asks for the second point rather than drawing nothing", () => {
    const { features, reading } = build("radius", [{ lon: 0, lat: 0 }]);
    expect(reading).toMatch(/edge/i);
    // The placed point is still drawn — a first click that appears to do
    // nothing reads as a broken tool.
    expect(features).toHaveLength(1);
  });

  it("reports a circle's radius and area together", () => {
    const { reading } = build("radius", [
      { lon: 0, lat: 0 },
      { lon: 0, lat: 1 },
    ]);
    expect(reading).toContain("111");
    expect(reading).toContain("km²");
  });

  it("normalises a box drawn from any corner", () => {
    const a = build("box", [
      { lon: 10, lat: 10 },
      { lon: 0, lat: 0 },
    ]);
    const b = build("box", [
      { lon: 0, lat: 0 },
      { lon: 10, lat: 10 },
    ]);
    expect(a.reading).toBe(b.reading);
  });

  it("sums a path leg by leg", () => {
    const { reading } = build("path", [
      { lon: 0, lat: 0 },
      { lon: 0, lat: 1 },
      { lon: 0, lat: 2 },
    ]);
    expect(reading).toContain("2 legs");
    expect(reading).toMatch(/222/);
  });

  it("says one leg, not 1 legs", () => {
    const { reading } = build("path", [
      { lon: 0, lat: 0 },
      { lon: 0, lat: 1 },
    ]);
    expect(reading).toContain("1 leg");
    expect(reading).not.toContain("legs");
  });
});

describe("formatting", () => {
  it("switches units at a readable threshold", () => {
    expect(formatDistance(950)).toBe("950 m");
    expect(formatDistance(1500)).toBe("1.50 km");
    expect(formatDistance(5_570_000)).toBe("5,570 km");
    expect(formatArea(500_000)).toBe("500,000 m²");
    expect(formatArea(2_500_000)).toBe("2.50 km²");
  });
});

import { describe, expect, it } from "vitest";
import { areaOf, assertArea, assertWatchableLayers } from "./geo.js";

/**
 * A geofence watches a place. These pin the two properties that matter: the
 * box has to be a real box, and the layers it names have to be things that
 * can meaningfully be inside one.
 */

describe("area validation", () => {
  it("accepts a well-formed box", () => {
    expect(assertArea({ south: 49.9, west: 36.1, north: 50.1, east: 36.4 })).toEqual({
      south: 49.9,
      west: 36.1,
      north: 50.1,
      east: 36.4,
    });
  });

  it("refuses an inside-out box", () => {
    // Swapped corners would silently match nothing rather than erroring, and a
    // geofence that can never fire is worse than one that refuses to exist.
    expect(() => assertArea({ south: 50.1, west: 36.1, north: 49.9, east: 36.4 })).toThrow(
      /inside out/i,
    );
    expect(() => assertArea({ south: 49.9, west: 36.4, north: 50.1, east: 36.1 })).toThrow(
      /inside out/i,
    );
  });

  it("refuses impossible latitudes", () => {
    expect(() => assertArea({ south: -91, west: 0, north: 10, east: 10 })).toThrow();
  });

  it("refuses anything that is not four numbers", () => {
    expect(() => assertArea(null)).toThrow();
    expect(() => assertArea({ south: "49.9", west: 36.1, north: 50.1, east: 36.4 })).toThrow();
    expect(() => assertArea({ south: 49.9, west: 36.1 })).toThrow();
    expect(() => assertArea({ south: Number.NaN, west: 0, north: 1, east: 1 })).toThrow();
  });
});

describe("watchable layers", () => {
  it("accepts live layers that have a position", () => {
    expect(assertWatchableLayers(["military", "fires"])).toEqual(["military", "fires"]);
  });

  it("refuses a layer with no fixed position", () => {
    // Day/night covers half the planet and terrain is everywhere: a geofence
    // over either would fire constantly and mean nothing.
    expect(() => assertWatchableLayers(["day_night"])).toThrow(/fixed position/i);
    expect(() => assertWatchableLayers(["terrain_3d"])).toThrow(/fixed position/i);
  });

  it("refuses an unknown layer", () => {
    expect(() => assertWatchableLayers(["not_a_layer"])).toThrow(/not a live layer/i);
  });

  it("refuses an empty list", () => {
    expect(() => assertWatchableLayers([])).toThrow(/at least one layer/i);
  });

  it("offers no person-facing layer to watch", () => {
    // The standing constraint, asserted rather than assumed: a geofence can
    // only name live map layers, and none of them is a person-facing source.
    for (const personFacing of ["hibp", "sherlock", "maigret", "whatsmyname", "gravatar", "hunter-io"]) {
      expect(() => assertWatchableLayers([personFacing])).toThrow(/not a live layer/i);
    }
  });
});

describe("reading a stored area", () => {
  it("reads a well-formed one back", () => {
    const area = { south: 1, west: 2, north: 3, east: 4 };
    expect(areaOf({ area })).toEqual(area);
  });

  it("returns null for an indicator monitor", () => {
    // Which is how the run path decides which kind of monitor it is looking at.
    expect(areaOf({ area: null })).toBeNull();
    expect(areaOf({ area: "not an area" })).toBeNull();
    expect(areaOf({ area: { south: 1, west: 2 } })).toBeNull();
  });
});

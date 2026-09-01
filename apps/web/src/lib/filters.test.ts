import { describe, expect, it } from "vitest";
import {
  compileAll,
  fieldsFor,
  filtersToSearch,
  matches,
  parseFilters,
  type Predicate,
} from "./filters.js";

/**
 * The map filter and the count beside it are computed by two different code
 * paths — a MapLibre expression on the GPU, and JavaScript over the held
 * features. They have to agree, or the readout says "41 of 2,180" while the
 * map shows something else, and the number is worse than no number.
 *
 * These tests pin the agreement and the null handling, which is where the two
 * most easily diverge.
 */

const aircraft = {
  tier: "military",
  altitudeM: 11000,
  speedKts: 420,
  aircraftType: "C30J",
  emergency: null,
  grounded: false,
  registration: "168218",
};

const noAltitude = { tier: "military", aircraftType: "V22" };

describe("predicate matching", () => {
  it("matches an exact value", () => {
    expect(matches(aircraft, [{ field: "tier", operator: "is", value: "military" }])).toBe(true);
    expect(matches(aircraft, [{ field: "tier", operator: "is", value: "jet" }])).toBe(false);
  });

  it("combines predicates as AND", () => {
    const both: Predicate[] = [
      { field: "tier", operator: "is", value: "military" },
      { field: "altitudeM", operator: "gte", value: "9144" },
    ];
    expect(matches(aircraft, both)).toBe(true);
    expect(matches({ ...aircraft, altitudeM: 500 }, both)).toBe(false);
  });

  it("treats a missing number as unknown, not as zero", () => {
    // The bug this catches: coalescing a missing altitude to 0 would put every
    // aircraft with no altitude reading below every threshold, silently
    // answering "none are high" when the truth is "we do not know".
    expect(matches(noAltitude, [{ field: "altitudeM", operator: "gte", value: "9144" }])).toBe(false);
    expect(matches(noAltitude, [{ field: "altitudeM", operator: "lte", value: "9144" }])).toBe(false);
  });

  it("matches a substring case-insensitively", () => {
    expect(matches(aircraft, [{ field: "aircraftType", operator: "contains", value: "c30" }])).toBe(true);
    expect(matches(aircraft, [{ field: "aircraftType", operator: "contains", value: "b77" }])).toBe(false);
  });

  it("treats an empty contains as no constraint", () => {
    expect(matches(aircraft, [{ field: "aircraftType", operator: "contains", value: "" }])).toBe(true);
  });

  it("does not treat a false flag as present", () => {
    // `grounded: false` is a published answer of "no", not a missing field.
    expect(matches(aircraft, [{ field: "grounded", operator: "exists", value: "" }])).toBe(false);
    expect(matches(aircraft, [{ field: "emergency", operator: "exists", value: "" }])).toBe(false);
    expect(matches({ emergency: "General emergency" }, [{ field: "emergency", operator: "exists", value: "" }])).toBe(true);
  });
});

describe("compilation", () => {
  it("uses a finite sentinel for a missing number, never Infinity", () => {
    // A MapLibre expression is JSON and JSON has no infinity: it serialises to
    // null and the comparison becomes undefined behaviour. The sentinel has to
    // survive a round trip through JSON.
    const expression = compileAll([
      { field: "altitudeM", operator: "gte", value: "9144" },
    ]);
    const round = JSON.parse(JSON.stringify(expression)) as unknown;
    expect(JSON.stringify(round)).toBe(JSON.stringify(expression));
    expect(JSON.stringify(expression)).not.toContain("null");
  });

  it("returns null for no predicates rather than a match-nothing filter", () => {
    // A filter of `["all"]` would be truthy and match everything; null means
    // "remove the filter", which is what the caller has to distinguish.
    expect(compileAll([])).toBeNull();
  });

  it("drops a predicate whose value is not a number", () => {
    expect(compileAll([{ field: "altitudeM", operator: "gte", value: "high" }])).toBeNull();
  });

  it("compiles a combined predicate to an `all` expression", () => {
    const expression = compileAll([
      { field: "tier", operator: "is", value: "military" },
      { field: "altitudeM", operator: "gte", value: "9144" },
    ]);
    expect(expression?.[0]).toBe("all");
    expect(expression).toHaveLength(3);
  });
});

describe("URL round trip", () => {
  it("survives a round trip", () => {
    const filters = {
      flights: [
        { field: "tier", operator: "is" as const, value: "military" },
        { field: "altitudeM", operator: "gte" as const, value: "9144" },
      ],
    };
    const search = filtersToSearch(["flights"], filters);
    expect(search).toContain("layers=flights");
    expect(parseFilters(search)).toEqual(filters);
  });

  it("survives values containing separators", () => {
    // A destination like "ROTTERDAM, NL" contains a comma, which is the
    // clause separator.
    const filters = {
      maritime: [{ field: "destination", operator: "contains" as const, value: "ROTTERDAM, NL" }],
    };
    expect(parseFilters(filtersToSearch(["maritime"], filters))).toEqual(filters);
  });

  it("drops an unknown operator from a hand-edited link", () => {
    expect(parseFilters("?filter=flights%3Atier%3Adrop%20table%3Ax")).toEqual({});
  });

  it("returns nothing for no filter", () => {
    expect(parseFilters("?layers=flights")).toEqual({});
  });
});

describe("field vocabularies", () => {
  it("shares one vocabulary across the four aircraft tiers", () => {
    const commercial = fieldsFor("flights").map((f) => f.field);
    for (const tier of ["private", "jets", "military", "sdk_air"]) {
      expect(fieldsFor(tier).map((f) => f.field)).toEqual(commercial);
    }
  });

  it("offers nothing for a layer with no useful fields", () => {
    expect(fieldsFor("day_night")).toEqual([]);
  });
});

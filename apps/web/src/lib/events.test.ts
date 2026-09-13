import { describe, expect, it } from "vitest";

import { describeEvent } from "./events";

describe("describeEvent", () => {
  it("reads a geofence back as a place, not a payload", () => {
    // This is the one that prompted the change: a bounding box printed as JSON
    // is something an operator has to decode before they know whether it
    // matters.
    const described = describeEvent({
      action: "monitor.created",
      detail: {
        monitorId: "cmti4xayb0003pierognsxz13",
        kind: "geofence",
        subjectKind: null,
        sourceIds: [],
        area: { south: 20.5, west: -159, north: 22.5, east: -157 },
        layerIds: ["military", "flights"],
        intervalMinutes: 5,
      },
    });

    expect(described.label).toBe("Geofence Created");
    expect(described.detail).toBe(
      "20.5°N–22.5°N, 159.0°W–157.0°W · watching military, flights · every 5 min",
    );
  });

  it("says why a baseline run reported nothing", () => {
    const described = describeEvent({
      action: "monitor.baseline",
      detail: { monitorId: "x", observations: 2 },
    });

    expect(described.label).toBe("Baseline Recorded");
    expect(described.detail).toContain("2 observations");
    expect(described.detail).toContain("first run");
  });

  it("names the authorisation a case was opened under", () => {
    const described = describeEvent({
      action: "case.created",
      detail: {
        name: "Geofence check",
        authorizationRef: "INTERNAL-TEST-0001",
        scopeEntryCount: 0,
      },
    });

    expect(described.detail).toBe(
      "Geofence check · authorised by INTERNAL-TEST-0001 · 0 scope entries",
    );
  });

  it("marks scope and purge changes as grave", () => {
    // Scope is the authorisation boundary and a purge is irreversible. Both
    // should be findable by eye in a long table.
    expect(describeEvent({ action: "scope.added", detail: {} }).weight).toBe("grave");
    expect(describeEvent({ action: "scope.removed", detail: {} }).weight).toBe("grave");
    expect(describeEvent({ action: "case.purged", detail: {} }).weight).toBe("grave");
    expect(describeEvent({ action: "monitor.baseline", detail: {} }).weight).toBe("normal");
  });

  it("singularises a count of one", () => {
    const one = describeEvent({ action: "audit.exported", detail: { rows: 1 } });
    const many = describeEvent({ action: "audit.exported", detail: { rows: 4 } });
    expect(one.detail).toBe("1 row");
    expect(many.detail).toBe("4 rows");
  });

  it("gives the reason a case was purged", () => {
    const described = describeEvent({
      action: "case.purged",
      detail: { findings: 2, subjects: 1, reason: "engagement closed" },
    });
    expect(described.detail).toBe(
      "2 findings · 1 subject · reason: engagement closed",
    );
  });

  it("falls back to the raw record for an action it does not know", () => {
    // Inventing a description for an unrecognised act would be worse than
    // showing the JSON: the reader could not tell the difference.
    const described = describeEvent({
      action: "something.new",
      detail: { a: 1 },
    });
    expect(described.label).toBe("something.new");
    expect(described.detail).toBe('{"a":1}');
  });

  it("survives a detail that is missing, null or the wrong shape", () => {
    for (const detail of [null, undefined, "a string", 7, []]) {
      expect(() =>
        describeEvent({ action: "monitor.created", detail }),
      ).not.toThrow();
    }
    expect(describeEvent({ action: "case.archived", detail: null }).detail).toBe("");
  });

  it("drops a half-written area rather than printing NaN", () => {
    const described = describeEvent({
      action: "monitor.created",
      detail: { kind: "geofence", area: { south: 20.5, west: -159 }, layerIds: ["fires"] },
    });
    expect(described.detail).toBe("watching fires");
  });
});

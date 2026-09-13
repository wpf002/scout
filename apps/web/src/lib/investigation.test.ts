import { describe, expect, it } from "vitest";

import { coverageBands, describeConfidence, earliest, lastPosition, mapLayer, stamp } from "./investigation";
import type { Entity, GraphEdge, Observation } from "./v2";

const obs = (id: string, sourceId: string, observedAt: string, position: { lon: number; lat: number } | null): Observation => ({
  id, sourceId, authorizationId: "a", collectedAt: observedAt, observedAt, normalizedPayload: {}, contentHash: id,
  position, confidenceBp: null, indeterminate: false, identifiers: [],
});
const entity = (id: string, kind: Entity["kind"], members: string[]): Entity => ({
  id, kind, canonicalLabel: id, status: "RESOLVED", lastResolvedAt: null, run: null, sourceIds: [],
  members: members.map((observationId) => ({ observationId, sourceId: "s", observedAt: "", collectedAt: "", scoreBp: 9000, method: "m", addedBy: "SYSTEM", addedAt: "" })),
});

describe("mapLayer", () => {
  const observations = [
    obs("o1", "s", "2026-06-01T10:00:00Z", { lon: 1, lat: 1 }),
    obs("o2", "s", "2026-06-01T12:00:00Z", { lon: 2, lat: 2 }),
    obs("o3", "s", "2026-06-02T09:00:00Z", { lon: 3, lat: 3 }),
    obs("o4", "s", "2026-06-01T11:00:00Z", null),
    obs("o5", "s", "2026-06-01T11:30:00Z", { lon: 5, lat: 5 }),
  ];
  const entities = [entity("E1", "VESSEL", ["o1", "o2", "o3"]), entity("E2", "PERSON", ["o4"])];

  it("draws positioned observations up to asOf and one trace per entity in time order", () => {
    const layer = mapLayer(observations, entities, [], new Date("2026-06-01T23:59:59Z"), "E1");
    expect(layer.points.map((p) => p.properties?.["observationId"]).sort()).toEqual(["o1", "o2", "o5"]);
    expect(layer.lines).toHaveLength(1);
    expect((layer.lines[0]?.geometry as GeoJSON.LineString).coordinates).toEqual([[1, 1], [2, 2]]);
    expect(layer.lines[0]?.properties?.["selected"]).toBe(true);
  });

  it("keeps an unresolved observation on the map, uncoloured", () => {
    const layer = mapLayer(observations, entities, [], new Date("2026-06-03T00:00:00Z"), null);
    const stray = layer.points.find((p) => p.properties?.["observationId"] === "o5");
    expect(stray?.properties?.["entityId"]).toBeNull();
    expect(stray?.properties?.["colour"]).toBe("#676c80");
  });

  it("draws a link only when both ends had a position by then", () => {
    const edge: GraphEdge = { id: "x", fromEntityId: "E1", toEntityId: "E3", relation: "CO_LOCATED", validFrom: "2026-06-01T00:00:00Z", validUntil: null, confidenceBp: 8400, basis: "co-location:2000m/30min", evidenceObservationIds: [] };
    const all = [...entities, entity("E3", "PERSON", ["o5"])];
    const before = mapLayer(observations, all, [edge], new Date("2026-06-01T11:00:00Z"), null);
    expect(before.links).toHaveLength(0);
    const after = mapLayer(observations, all, [edge], new Date("2026-06-02T12:00:00Z"), "E3");
    expect(after.links).toHaveLength(1);
    expect((after.links[0]?.geometry as GeoJSON.LineString).coordinates).toEqual([[3, 3], [5, 5]]);
    expect(after.links[0]?.properties?.["selected"]).toBe(true);
    expect(after.links[0]?.properties?.["basis"]).toBe("co-location:2000m/30min");
  });

  it("reports the last position by asOf, or none", () => {
    const e1 = entities[0] as Entity;
    expect(lastPosition(observations, e1, new Date("2026-06-01T12:30:00Z"))).toEqual({ lon: 2, lat: 2, at: "2026-06-01T12:00:00Z" });
    expect(lastPosition(observations, e1, new Date("2026-06-01T09:00:00Z"))).toBeNull();
  });

  it("extends the trace as asOf moves forward", () => {
    const later = mapLayer(observations, entities, [], new Date("2026-06-03T00:00:00Z"), null);
    expect((later.lines[0]?.geometry as GeoJSON.LineString).coordinates).toEqual([[1, 1], [2, 2], [3, 3]]);
  });
});

describe("coverageBands", () => {
  it("puts each observation in its bucket and leaves the gaps empty", () => {
    const from = new Date("2026-06-01T00:00:00Z");
    const to = new Date("2026-06-01T10:00:00Z");
    const bands = coverageBands(
      [obs("a", "s1", "2026-06-01T00:30:00Z", null), obs("b", "s1", "2026-06-01T00:45:00Z", null), obs("c", "s2", "2026-06-01T09:59:00Z", null), obs("d", "s1", "2026-07-01T00:00:00Z", null)],
      ["s1", "s2", "s3"], from, to, 10,
    );
    const s1 = bands.find((b) => b.sourceId === "s1");
    expect(s1?.counts).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(s1?.total).toBe(2);
    expect(bands.find((b) => b.sourceId === "s2")?.counts[9]).toBe(1);
    expect(bands.find((b) => b.sourceId === "s3")?.total).toBe(0);
  });
});

describe("earliest and describeConfidence", () => {
  it("finds the earliest observation and falls back when there are none", () => {
    const fallback = new Date("2026-01-01T00:00:00Z");
    expect(earliest([obs("a", "s", "2026-06-02T00:00:00Z", null), obs("b", "s", "2026-06-01T00:00:00Z", null)], fallback).toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(earliest([], fallback)).toBe(fallback);
  });

  it("never shows a confidence without its basis", () => {
    expect(describeConfidence(7500, "shared:PHONE")).toBe("7 500 bp · shared phone");
    expect(describeConfidence(8400, "co-location:2000m/30min")).toBe("8 400 bp · within 2000 m and 30 min");
    expect(describeConfidence(10000, "asserted")).toBe("10 000 bp · asserted by an analyst");
    expect(describeConfidence(9000, null)).toBe("9 000 bp");
  });

  it("stamps every timestamp the same way", () => {
    expect(stamp("2026-08-14T13:00:59.000Z")).toBe("2026-08-14 13:00Z");
    expect(stamp("nope")).toBe("—");
  });
});

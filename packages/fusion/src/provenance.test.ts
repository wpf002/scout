import { describe, expect, it } from "vitest";

import { ProvenanceError, assertProvenance, contentHash } from "./provenance.js";

const good = {
  sourceId: "opensky",
  authorizationId: "auth_1",
  collectedAt: "2026-09-13T12:00:00Z",
  observedAt: "2026-09-13T11:59:58Z",
  rawPayload: { icao24: "abc123" },
  normalizedPayload: { icao24: "abc123", lon: 1, lat: 2 },
  position: { lon: 1, lat: 2 },
};

describe("assertProvenance", () => {
  it("accepts a fully provenanced observation", () => {
    const parsed = assertProvenance(good);
    expect(parsed.collectedAt).toBeInstanceOf(Date);
    expect(parsed.indeterminate).toBe(false);
    expect(parsed.confidenceBp).toBeNull();
  });

  it("refuses a missing field and names it", () => {
    for (const field of ["sourceId", "authorizationId", "collectedAt", "observedAt"]) {
      const { [field]: _dropped, ...rest } = good as Record<string, unknown>;
      expect(() => assertProvenance(rest)).toThrow(ProvenanceError);
      try {
        assertProvenance(rest);
      } catch (e) {
        expect((e as ProvenanceError).missing).toEqual([field]);
      }
    }
  });

  it("treats empty strings and nulls as missing", () => {
    expect(() => assertProvenance({ ...good, sourceId: "" })).toThrow(/sourceId/);
    expect(() => assertProvenance({ ...good, authorizationId: null })).toThrow(/authorizationId/);
  });

  it("lists every missing field at once", () => {
    try {
      assertProvenance({ rawPayload: {}, normalizedPayload: {} });
    } catch (e) {
      expect((e as ProvenanceError).missing).toEqual([
        "sourceId",
        "authorizationId",
        "collectedAt",
        "observedAt",
      ]);
    }
  });

  it("refuses unknown fields rather than dropping them", () => {
    expect(() => assertProvenance({ ...good, entityId: "e1" })).toThrow();
  });

  it("refuses an out-of-range position or confidence", () => {
    expect(() => assertProvenance({ ...good, position: { lon: 200, lat: 0 } })).toThrow();
    expect(() => assertProvenance({ ...good, confidenceBp: 10_001 })).toThrow();
    expect(() => assertProvenance({ ...good, confidenceBp: 99.5 })).toThrow();
  });
});

describe("contentHash", () => {
  it("is stable across key order and nesting", () => {
    const a = contentHash({ b: 1, a: { y: [1, 2], x: "s" } });
    const b = contentHash({ a: { x: "s", y: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when content changes", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash({ a: [1, 2] })).not.toBe(contentHash({ a: [2, 1] }));
  });
});

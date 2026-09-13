import { describe, expect, it } from "vitest";
import { ScopeContext } from "@scout/scope";

import {
  CollectorError,
  CollectorRegistry,
  assertMayCollect,
  defineCollector,
} from "./collector.js";

const NOW = new Date("2026-09-13T12:00:00Z");

const definition = {
  id: "opensky",
  name: "OpenSky Network",
  sourceClass: "SENSOR" as const,
  licensingTerms: "OpenSky Network terms of use; non-commercial research tier.",
  refreshCadenceSeconds: 20,
  rateLimit: { perMinute: 4 },
};

const noop = () => [];

function ctx(actionClasses: string[], sourceClasses: string[]) {
  return ScopeContext.build({
    operator: "alice",
    now: NOW,
    authorization: {
      id: "auth_1",
      reference: "ENG-1",
      issuedBy: "engagement letter",
      boundary: { scope: [], entityKinds: [] },
      sourceClasses,
      actionClasses,
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2027-01-01T00:00:00Z",
      revokedAt: null,
    },
  });
}

describe("defineCollector", () => {
  it("loads a collector that states its terms", () => {
    const c = defineCollector(definition, noop);
    expect(c.id).toBe("opensky");
    expect(c.normalize({}, { collectedAt: NOW, authorizationId: "a" })).toEqual([]);
  });

  it("refuses a collector with no licensing terms", () => {
    expect(() => defineCollector({ ...definition, licensingTerms: "" }, noop)).toThrow(
      /does not state its licensing terms/,
    );
    expect(() => defineCollector({ ...definition, licensingTerms: "n/a" }, noop)).toThrow(CollectorError);
  });

  it("refuses an uppercase or spaced id", () => {
    expect(() => defineCollector({ ...definition, id: "Open Sky" }, noop)).toThrow(/misdeclared/);
  });
});

describe("CollectorRegistry", () => {
  it("refuses a duplicate id", () => {
    const r = new CollectorRegistry();
    r.register(defineCollector(definition, noop));
    expect(() => r.register(defineCollector(definition, noop))).toThrow(/already registered/);
    expect(r.list().map((c) => c.id)).toEqual(["opensky"]);
  });
});

describe("assertMayCollect", () => {
  const collector = defineCollector(definition, noop);

  it("permits COLLECT on a permitted source class", () => {
    expect(() => assertMayCollect(ctx(["COLLECT"], ["SENSOR"]), collector)).not.toThrow();
  });

  it("refuses without COLLECT", () => {
    expect(() => assertMayCollect(ctx(["READ_GRAPH"], ["SENSOR"]), collector)).toThrow(
      /does not permit COLLECT/,
    );
  });

  it("refuses a source class the authorization does not list", () => {
    expect(() => assertMayCollect(ctx(["COLLECT"], ["PUBLIC_RECORD"]), collector)).toThrow(/SENSOR/);
  });
});

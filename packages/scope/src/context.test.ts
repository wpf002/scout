import { describe, expect, it } from "vitest";

import { ScopeContext } from "./context.js";
import { ScopeError } from "./types.js";

const NOW = new Date("2026-09-13T12:00:00Z");

const base = {
  id: "auth_1",
  reference: "ENG-2026-014",
  issuedBy: "Client counsel, engagement letter 14",
  boundary: {
    scope: [
      { kind: "domain", value: "example.com" },
      { kind: "identifier", value: "alice@example.com" },
    ],
    entityKinds: [],
  },
  sourceClasses: ["PUBLIC_RECORD", "SENSOR"],
  actionClasses: ["COLLECT", "READ_GRAPH"],
  validFrom: "2026-09-01T00:00:00Z",
  validUntil: "2026-12-31T00:00:00Z",
  revokedAt: null,
};

describe("ScopeContext.build", () => {
  it("builds from a live authorization", () => {
    const ctx = ScopeContext.build({ authorization: base, operator: "alice", now: NOW });
    expect(ctx.authorizationId).toBe("auth_1");
    expect(ctx.issuingAuthority).toContain("counsel");
    expect(ctx.toAuditFields()).toEqual({ authorizationId: "auth_1", actor: "alice" });
  });

  it("refuses a revoked authorization", () => {
    expect(() =>
      ScopeContext.build({
        authorization: { ...base, revokedAt: "2026-09-10T00:00:00Z" },
        operator: "alice",
        now: NOW,
      }),
    ).toThrow(ScopeError);
    try {
      ScopeContext.build({ authorization: { ...base, revokedAt: "2026-09-10T00:00:00Z" }, operator: "a", now: NOW });
    } catch (e) {
      expect((e as ScopeError).reason).toBe("authorization-revoked");
    }
  });

  it("refuses an expired authorization", () => {
    expect(() =>
      ScopeContext.build({ authorization: base, operator: "alice", now: new Date("2027-01-01T00:00:00Z") }),
    ).toThrow(/expired/);
  });

  it("refuses an authorization that has not started", () => {
    expect(() =>
      ScopeContext.build({ authorization: base, operator: "alice", now: new Date("2026-08-01T00:00:00Z") }),
    ).toThrow(/not valid until/);
  });

  it("refuses a record whose window is inverted", () => {
    expect(() =>
      ScopeContext.build({
        authorization: { ...base, validFrom: base.validUntil, validUntil: base.validFrom },
        operator: "alice",
        now: NOW,
      }),
    ).toThrow(/validUntil/);
  });

  it("refuses garbage", () => {
    expect(() => ScopeContext.build({ authorization: { id: "x" }, operator: "a", now: NOW })).toThrow();
    expect(() => ScopeContext.build({ authorization: null, operator: "a", now: NOW })).toThrow();
  });
});

describe("ScopeContext permissions", () => {
  const ctx = ScopeContext.build({ authorization: base, operator: "alice", now: NOW });

  it("permits listed action classes and refuses the rest", () => {
    expect(ctx.permitsAction("COLLECT")).toBe(true);
    expect(ctx.permitsAction("BIOMETRIC_COMPARE")).toBe(false);
    expect(() => ctx.assertAction("BIOMETRIC_COMPARE")).toThrow(/does not permit BIOMETRIC_COMPARE/);
  });

  it("permits listed source classes and refuses the rest", () => {
    expect(ctx.permitsSourceClass("SENSOR")).toBe(true);
    expect(() => ctx.assertSourceClass("BROKER")).toThrow(/BROKER/);
  });

  it("answers subject coverage with the v1 matcher", () => {
    expect(ctx.covers({ kind: "domain", value: "api.example.com" }).allowed).toBe(true);
    expect(ctx.covers({ kind: "domain", value: "notexample.com" }).allowed).toBe(false);
    expect(ctx.covers({ kind: "email", value: "alice@example.com" }).allowed).toBe(true);
    expect(() => ctx.assertCovers({ kind: "email", value: "bob@evil.net" })).toThrow(ScopeError);
  });

  it("re-checks the window on assertLive", () => {
    expect(() => ctx.assertLive(NOW)).not.toThrow();
    expect(() => ctx.assertLive(new Date("2027-06-01T00:00:00Z"))).toThrow(/expired/);
  });

  it("limits entity kinds only when the boundary lists any", () => {
    expect(ctx.permitsEntityKind("VESSEL")).toBe(true);
    const narrow = ScopeContext.build({
      authorization: { ...base, boundary: { ...base.boundary, entityKinds: ["AIRCRAFT"] } },
      operator: "alice",
      now: NOW,
    });
    expect(narrow.permitsEntityKind("AIRCRAFT")).toBe(true);
    expect(narrow.permitsEntityKind("PERSON")).toBe(false);
  });
});

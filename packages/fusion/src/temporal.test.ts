import { describe, expect, it } from "vitest";

import { asOfSql, knownAt } from "./temporal.js";

const d = (s: string) => new Date(s);

describe("knownAt", () => {
  const edge = {
    validFrom: d("2026-03-01T00:00:00Z"),
    validUntil: d("2026-06-01T00:00:00Z"),
    createdAt: d("2026-05-15T00:00:00Z"),
    supersededAt: null,
  };

  it("is false before the relationship held", () => {
    expect(knownAt(edge, d("2026-02-01T00:00:00Z"))).toBe(false);
  });

  it("is false while it held but before Scout knew about it", () => {
    // Held in March. Learned in mid-May. A scrub to April shows the graph as
    // it was known in April, which did not include this edge.
    expect(knownAt(edge, d("2026-04-01T00:00:00Z"))).toBe(false);
  });

  it("is true once both held and known", () => {
    expect(knownAt(edge, d("2026-05-20T00:00:00Z"))).toBe(true);
  });

  it("is false after validUntil, exclusive", () => {
    expect(knownAt(edge, d("2026-06-01T00:00:00Z"))).toBe(false);
    expect(knownAt(edge, d("2026-05-31T23:59:59Z"))).toBe(true);
  });

  it("treats a null validUntil as still holding", () => {
    expect(knownAt({ ...edge, validUntil: null }, d("2030-01-01T00:00:00Z"))).toBe(true);
  });

  it("hides a superseded row after supersession", () => {
    const superseded = { ...edge, supersededAt: d("2026-05-25T00:00:00Z") };
    expect(knownAt(superseded, d("2026-05-20T00:00:00Z"))).toBe(true);
    expect(knownAt(superseded, d("2026-05-26T00:00:00Z"))).toBe(false);
  });

  it("includes validFrom and createdAt, inclusive", () => {
    expect(knownAt({ ...edge, createdAt: d("2026-03-01T00:00:00Z") }, d("2026-03-01T00:00:00Z"))).toBe(true);
  });
});

describe("asOfSql", () => {
  it("emits both clocks against the given placeholder", () => {
    const sql = asOfSql("e", "$1");
    expect(sql).toContain('e."validFrom" <= $1');
    expect(sql).toContain('e."validUntil" IS NULL OR e."validUntil" > $1');
    expect(sql).toContain('e."createdAt" <= $1');
    expect(sql).toContain('e."supersededAt" IS NULL OR e."supersededAt" > $1');
  });
});

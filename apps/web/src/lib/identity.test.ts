import { describe, expect, it } from "vitest";

import { buildIdentities, parsePersonName } from "./identity";
import type { RunResultRow } from "./api";

const row = (sourceId: string, data: unknown[]): RunResultRow => ({
  sourceId,
  name: sourceId,
  tier: "datasets",
  mode: "api",
  requiresScope: false,
  status: "ok",
  reason: null,
  message: null,
  data,
  count: data.length,
  url: null,
  durationMs: 1,
});

const voter = (title: string, excerpt: string, entityType: string | null = null) => ({
  kind: "dataset-hit",
  datasetId: "voter-file:nc",
  title,
  entityType,
  excerpt,
});

const fec = (title: string, employer: string, excerpt: string) => ({
  kind: "dataset-hit",
  datasetId: "fec",
  title,
  entityType: employer,
  excerpt,
});

describe("parsePersonName", () => {
  it("reduces both orderings to the same first and last", () => {
    expect(parsePersonName("JORDAN, MICHAEL A")).toMatchObject({ first: "MICHAEL", last: "JORDAN" });
    expect(parsePersonName("Michael Byron Jordan")).toMatchObject({ first: "MICHAEL", last: "JORDAN" });
  });

  it("strips honorifics and suffixes", () => {
    expect(parsePersonName("SMITH, BARRY E MR.")).toMatchObject({ first: "BARRY", last: "SMITH" });
    expect(parsePersonName("John Smith Jr")).toMatchObject({ first: "JOHN", last: "SMITH" });
  });

  it("refuses a single token", () => {
    expect(parsePersonName("Madonna")).toBeNull();
    expect(parsePersonName("")).toBeNull();
  });
});

describe("buildIdentities", () => {
  it("keeps two people with one name apart by locality", () => {
    const report = buildIdentities(
      [
        row("voter-file", [
          voter("MICHAEL KEITH JORDAN", "b. 1984 · 284 LINCOLN ST, CONCORD, NC, 28025 · REP", "b. 1984"),
          voter("MICHAEL ANTHONY JORDAN", "b. 1973 · 4139 STONECREST DR, BURLINGTON, NC, 27215 · UNA", "b. 1973"),
        ]),
      ],
      "Michael Jordan",
    );

    expect(report.identities).toHaveLength(2);
    expect(report.identities.map((i) => i.locality).sort()).toEqual(["BURLINGTON, NC", "CONCORD, NC"]);
  });

  it("joins two sources onto one person and names both", () => {
    const report = buildIdentities(
      [
        row("voter-file", [
          voter("MICHAEL KEITH JORDAN", "b. 1984 · 284 LINCOLN ST, CONCORD, NC, 28025 · REP", "b. 1984"),
        ]),
        row("fec", [
          fec("JORDAN, MICHAEL K", "UNITED AIRLINES", "PILOT · UNITED AIRLINES · CONCORD, NC, 28025 · $500"),
        ]),
      ],
      "Michael Jordan",
    );

    expect(report.identities).toHaveLength(1);
    const [only] = report.identities;
    expect(only?.sources).toEqual(["fec", "voter-file"]);
    expect(only?.employer).toBe("UNITED AIRLINES");
    expect(only?.party).toBe("REP");
    expect(only?.variants).toHaveLength(2);
  });

  it("never folds a different person in, and counts the drop", () => {
    const report = buildIdentities(
      [
        row("voter-file", [voter("MICHAEL JORDAN", "b. 1963 · 1 WAY, CHICAGO, IL, 60601 · DEM", "b. 1963")]),
        // OpenSanctions answers a Michael Jordan query with Frank Jordan.
        row("opensanctions", [{ kind: "sanction-match", caption: "Frank Jordan" }]),
      ],
      "Michael Jordan",
    );

    expect(report.identities).toHaveLength(1);
    expect(report.identities[0]?.name).toContain("MICHAEL");
    expect(report.discarded).toBe(1);
  });

  it("states what the grouping rests on", () => {
    const report = buildIdentities(
      [row("voter-file", [voter("MICHAEL JORDAN", "b. 1984 · 1 ST, CONCORD, NC, 28025 · REP", "b. 1984")])],
      "Michael Jordan",
    );
    expect(report.identities[0]?.basis).toBe("name + locality + birth year");
  });

  it("ranks a person two sources agree on above one only a single source has", () => {
    const report = buildIdentities(
      [
        row("voter-file", [
          voter("MICHAEL JORDAN", "b. 1970 · 1 A ST, RALEIGH, NC, 27601 · UNA", "b. 1970"),
          voter("MICHAEL JORDAN", "b. 1984 · 2 B ST, CONCORD, NC, 28025 · REP", "b. 1984"),
        ]),
        row("fec", [fec("JORDAN, MICHAEL", "ACME", "ENGINEER · ACME · CONCORD, NC, 28025 · $50")]),
      ],
      "Michael Jordan",
    );

    expect(report.identities[0]?.locality).toBe("CONCORD, NC");
    expect(report.identities[0]?.sources).toHaveLength(2);
  });

  it("returns nothing rather than throwing on no data", () => {
    expect(buildIdentities([], "Michael Jordan")).toEqual({ identities: [], discarded: 0 });
  });
});

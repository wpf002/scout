import { describe, expect, it } from "vitest";
import { contentHash } from "@scout/fusion";

import { listRunnable, naiveNormalize } from "./index.js";
import { normalizeAircraft } from "./adsb.js";
import { matchCompanies, normalizeCompanies } from "./sec-edgar.js";

const COLLECTED = new Date("2026-09-13T12:00:00Z");
const META = { collectedAt: COLLECTED, authorizationId: "auth_1", caseId: "case_1" };

const feature = (props: Record<string, unknown>, coords: [number, number] = [-122.4, 37.6]) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: coords },
  properties: props,
});

describe("the collector registry", () => {
  it("holds both stage-3 collectors, each with licensing terms", () => {
    const ids = listRunnable().map((c) => c.id).sort();
    expect(ids).toEqual(["adsb-live", "sec-edgar"]);
    for (const c of listRunnable()) expect(c.licensingTerms.length).toBeGreaterThan(40);
  });
});

describe("normalizeAircraft", () => {
  it("turns a track into a provenanced observation with identifiers and a position", () => {
    const [obs] = normalizeAircraft(
      { features: [feature({ icao24: "ABC123", label: "UAL123", registration: "N123AB", tier: "commercial", seenSecondsAgo: 12, altitudeM: 3000, heading: 90, speedKts: 210, source: "opensky" })] },
      META,
    );
    expect(obs?.sourceId).toBe("adsb-live");
    expect(obs?.authorizationId).toBe("auth_1");
    expect(obs?.caseId).toBe("case_1");
    expect(obs?.position).toEqual({ lon: -122.4, lat: 37.6 });
    // Observed twelve seconds before it was collected.
    expect(obs?.observedAt.getTime()).toBe(COLLECTED.getTime() - 12_000);
    expect(obs?.identifiers).toEqual([
      { kind: "ICAO_HEX", value: "abc123" },
      { kind: "TAIL_NUMBER", value: "N123AB" },
    ]);
    expect(obs?.normalizedPayload["upstream"]).toBe("opensky");
    expect(obs?.confidenceBp).toBeNull();
  });

  it("skips a track with no hex or no position", () => {
    expect(
      normalizeAircraft({ features: [feature({ label: "X" }), { type: "Feature", properties: { icao24: "a" } }] }, META),
    ).toEqual([]);
  });

  it("hashes to the same content on a repeated identical sweep", () => {
    const f = feature({ icao24: "abc123", seenSecondsAgo: 3 });
    const [a] = normalizeAircraft({ features: [f] }, META);
    const [b] = normalizeAircraft({ features: [f] }, { ...META, collectedAt: new Date(COLLECTED.getTime() + 60_000) });
    expect(contentHash(a?.normalizedPayload ?? {})).toBe(contentHash(b?.normalizedPayload ?? {}));
  });
});

describe("SEC EDGAR", () => {
  const companies = [
    { cik: "0000320193", ticker: "AAPL", title: "Apple Inc." },
    { cik: "0000789019", ticker: "MSFT", title: "Microsoft Corp" },
    { cik: "0001018724", ticker: "AMZN", title: "Amazon Com Inc" },
  ];

  it("matches a name as a substring and a number as a CIK", () => {
    expect(matchCompanies(companies, { kind: "company", value: "apple" }).map((c) => c.ticker)).toEqual(["AAPL"]);
    expect(matchCompanies(companies, { kind: "company", value: "320193" }).map((c) => c.ticker)).toEqual(["AAPL"]);
    expect(matchCompanies(companies, { kind: "company", value: "inc" })).toHaveLength(2);
    expect(matchCompanies(companies, { kind: "company", value: "   " })).toEqual([]);
  });

  it("normalizes a registrant with its CIK as a document number, dated to collection", () => {
    const [obs] = normalizeCompanies([companies[0]], META);
    expect(obs?.identifiers).toEqual([
      { kind: "NAME", value: "Apple Inc." },
      { kind: "DOCUMENT_NO", value: "CIK0000320193" },
    ]);
    expect(obs?.observedAt).toEqual(COLLECTED);
    expect(obs?.normalizedPayload["observedAtBasis"]).toBe("collection");
    expect(obs?.position).toBeNull();
  });
});

describe("naiveNormalize", () => {
  it("folds case and whitespace, and keeps only digits for phones", () => {
    expect(naiveNormalize("NAME", "  Apple   Inc. ")).toBe("apple inc.");
    expect(naiveNormalize("PHONE", "(415) 555-0123")).toBe("4155550123");
    expect(naiveNormalize("TAIL_NUMBER", "n123ab ")).toBe("N123AB");
    expect(naiveNormalize("DOCUMENT_NO", "cik 0000320193")).toBe("CIK0000320193");
  });
});

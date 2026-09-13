import { describe, expect, it } from "vitest";
import { contentHash } from "@scout/fusion";

import { defineBrokerAdapter, listRunnable, naiveNormalize } from "./index.js";
import { collectAisStream, normalizeVessels, parseSightingTime, sightingsFromMaritime, type SocketLike } from "./ais.js";
import { normalizeTelemetry } from "./telemetry.js";
import { extractFacts, robotsAllows } from "./open-web.js";
import { bboxHash, isCloudOptimized, pixelSize } from "./imagery.js";
import { normalizePlanet } from "./planet.js";
import { normalizeMaxar } from "./maxar.js";
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
  it("holds every collector, each with licensing terms", () => {
    const ids = listRunnable().map((c) => c.id).sort();
    expect(ids).toEqual(["adsb-live", "ais-live", "first-party-telemetry", "maxar-catalog", "open-web", "planet-scenes", "sec-edgar", "sentinel-2"]);
    for (const c of listRunnable()) expect(c.licensingTerms.length).toBeGreaterThan(40);
  });

  it("refuses a broker adapter without a contract or credentials, and ships none", () => {
    const shape = { id: "acme-broker", name: "Acme", tosUrl: "https://acme.example/tos", licensingTerms: "Licensed people-data under contract.", refreshCadenceSeconds: 3600, entityKind: "PERSON" as const, fetch: async () => ({}), normalize: () => [] };
    expect(() => defineBrokerAdapter({ ...shape, contractRef: "", credentialsEnv: "ACME_KEY" })).toThrow(/contract/);
    expect(() => defineBrokerAdapter({ ...shape, contractRef: "MSA-2026-04", credentialsEnv: " " })).toThrow(/credentials/);
    const ok = defineBrokerAdapter({ ...shape, contractRef: "MSA-2026-04", credentialsEnv: "ACME_KEY" });
    expect(ok.sourceClass).toBe("BROKER");
    expect(ok.licensingTerms).toContain("MSA-2026-04");
    expect(listRunnable().some((c) => c.sourceClass === "BROKER")).toBe(false);
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

describe("the AIS collector", () => {
  const vessel = feature({ layer: "maritime", role: "vessel", label: "MS TESTFJORD", mmsi: 257123456, imo: 9123456, callsign: "LATE", shipType: "Passenger", destination: "BERGEN", speedKn: 11.5, heading: 42, at: "2026-09-13T11:58:00Z", authority: "Kystverket (Norway)" }, [5.31, 60.4]);
  const port = feature({ layer: "maritime", role: "port", label: "Bergen" }, [5.32, 60.39]);

  it("keeps vessels and drops the reference geography", () => {
    const sightings = sightingsFromMaritime({ features: [vessel, port] } as never);
    expect(sightings).toHaveLength(1);
    expect(sightings[0]).toMatchObject({ mmsi: "257123456", name: "MS TESTFJORD", imo: "9123456", upstream: "Kystverket (Norway)", lon: 5.31, lat: 60.4 });
  });

  it("writes a vessel observation with MMSI, IMO and name identifiers at the reported time", () => {
    const [obs] = normalizeVessels({ sightings: sightingsFromMaritime({ features: [vessel] } as never) }, META);
    expect(obs?.entityKind).toBe("VESSEL");
    expect(obs?.observedAt.toISOString()).toBe("2026-09-13T11:58:00.000Z");
    expect(obs?.identifiers).toEqual([{ kind: "MMSI", value: "257123456" }, { kind: "IMO", value: "9123456" }, { kind: "NAME", value: "MS TESTFJORD" }]);
    expect(obs?.normalizedPayload["upstream"]).toBe("Kystverket (Norway)");
  });

  it("reads AISStream's time format and falls back to collection time", () => {
    expect(parseSightingTime("2026-09-13 12:34:56.789 +0000 UTC", COLLECTED).toISOString()).toBe("2026-09-13T12:34:56.789Z");
    expect(parseSightingTime("garbage", COLLECTED)).toBe(COLLECTED);
    expect(parseSightingTime(null, COLLECTED)).toBe(COLLECTED);
  });

  it("subscribes to the box, keeps the latest position per MMSI, and closes when the window ends", async () => {
    const sent: string[] = [];
    let closed = false;
    const listeners = new Map<string, (event: { data?: unknown }) => void>();
    const socket: SocketLike = {
      send: (data) => sent.push(data),
      close: () => { closed = true; },
      addEventListener: (type, listener) => { listeners.set(type, listener); },
    };
    const pending = collectAisStream({ apiKey: "k", params: { bbox: [4, 59, 6, 61], windowSeconds: 1 }, open: () => socket });
    listeners.get("open")?.({});
    const report = (mmsi: number, lon: number, name = "A") => JSON.stringify({ MessageType: "PositionReport", MetaData: { MMSI: mmsi, ShipName: name, latitude: 60, longitude: lon, time_utc: "2026-09-13 12:00:00 +0000 UTC" }, Message: { PositionReport: { Sog: 9.5, TrueHeading: 90 } } });
    listeners.get("message")?.({ data: report(1, 5.0) });
    listeners.get("message")?.({ data: report(1, 5.1) });
    listeners.get("message")?.({ data: report(2, 5.5, "B") });
    listeners.get("message")?.({ data: "not json" });
    listeners.get("message")?.({ data: JSON.stringify({ MessageType: "ShipStaticData" }) });
    const sightings = await pending;
    expect(JSON.parse(sent[0] as string)).toEqual({ APIKey: "k", BoundingBoxes: [[[59, 4], [61, 6]]], FilterMessageTypes: ["PositionReport"] });
    expect(closed).toBe(true);
    expect(sightings.map((s) => [s.mmsi, s.lon])).toEqual([["1", 5.1], ["2", 5.5]]);
    expect(sightings[0]?.upstream).toBe("AISStream.io");
  });
});

describe("first-party telemetry", () => {
  it("writes one DEVICE observation per point and refuses a batch without a consent reference", () => {
    const rows = normalizeTelemetry({ consentRef: "CONSENT-77", deviceId: "truck-12", label: "Truck 12", points: [{ at: "2026-09-13T10:00:00Z", lon: 5, lat: 60, speedKn: 12 }, { at: "2026-09-13T10:01:00Z", lon: 5.01, lat: 60.01 }] }, META);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ entityKind: "DEVICE", position: { lon: 5, lat: 60 } });
    expect(rows[0]?.identifiers).toEqual([{ kind: "DEVICE_ID", value: "truck-12" }, { kind: "NAME", value: "Truck 12" }]);
    expect(rows[0]?.normalizedPayload["consentRef"]).toBe("CONSENT-77");
    expect(() => normalizeTelemetry({ deviceId: "truck-12", points: [{ at: "2026-09-13T10:00:00Z", lon: 5, lat: 60 }] }, META)).toThrow();
  });
});

describe("the open web collector", () => {
  it("obeys robots.txt with the most specific rule winning", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /private/\nAllow: /\n", "/")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /private/\nAllow: /\n", "/private/x")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /\n", "/")).toBe(false);
    expect(robotsAllows("User-agent: Googlebot\nDisallow: /\n", "/")).toBe(true);
    expect(robotsAllows("User-agent: Scout-OSINT\nDisallow: /\n\nUser-agent: *\nAllow: /\n", "/")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow:\n", "/anything")).toBe(true);
    expect(robotsAllows("", "/")).toBe(true);
  });

  it("keeps what a page states about itself and ignores scripts", () => {
    const facts = extractFacts("https://example.org/", `<html><head><title>Example &amp; Sons</title><meta name="description" content="A family firm."></head><body><script>var x="hidden@nowhere.test"</script><p>hello@example.org, +44 20 7946 0958</p><a href="https://x.com/examplesons">x</a></body></html>`, COLLECTED);
    expect(facts).toMatchObject({ title: "Example & Sons", description: "A family firm.", emails: ["hello@example.org"], handles: ["@examplesons"], phones: ["+44 20 7946 0958"] });
  });
});

describe("the imagery pipeline", () => {
  it("sizes a box at native resolution and coarsens past the cap", () => {
    const small = pixelSize([5.3, 60.39, 5.32, 60.40], 10);
    expect(small.resolutionM).toBe(10);
    expect(small.width).toBeGreaterThan(90);
    expect(small.height).toBeGreaterThan(90);
    const big = pixelSize([5.0, 60.0, 5.5, 60.5], 10);
    expect(big.resolutionM).toBeGreaterThan(10);
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(1024);
  });

  it("hashes a box stably and only calls a TIFF cloud-optimized when it says so", () => {
    expect(bboxHash([5.3, 60.39, 5.32, 60.4])).toBe(bboxHash([5.3000001, 60.39, 5.32, 60.4]));
    expect(bboxHash([5.3, 60.39, 5.32, 60.4])).not.toBe(bboxHash([5.31, 60.39, 5.32, 60.4]));
    expect(isCloudOptimized(new TextEncoder().encode("II*\u0000 plain"))).toBe(false);
    expect(isCloudOptimized(new TextEncoder().encode("II*\u0000 ... LAYOUT=IFDS_BEFORE_DATA ..."))).toBe(true);
  });

  it("records catalogue scenes from Planet and Maxar as unstored metadata", () => {
    const params = { bbox: [5.3, 60.39, 5.32, 60.4] as [number, number, number, number], from: new Date("2026-09-01"), to: new Date("2026-09-10"), maxCloudPct: 30, maxScenes: 2 };
    const [planet] = normalizePlanet({ params, scenes: [{ itemId: "p1", itemType: "PSScene", acquired: "2026-09-02T10:15:12Z", cloudCoverPct: 8, satelliteId: "2455", gsdM: 3.9 }] }, META);
    expect(planet?.entityKind).toBe("LOCATION");
    expect(planet?.position?.lon).toBeCloseTo(5.31, 6);
    expect(planet?.position?.lat).toBeCloseTo(60.395, 6);
    expect(planet?.normalizedPayload).toMatchObject({ provider: "planet", stored: false, cloudCoverPct: 8 });
    const [maxar] = normalizeMaxar({ params, scenes: [{ itemId: "m1", collection: "wv03-vis", sensedAt: "2026-09-03T11:02:00Z", cloudCoverPct: 5, platform: "worldview-03", gsdM: 0.31 }] }, META);
    expect(maxar?.normalizedPayload).toMatchObject({ provider: "maxar", platform: "worldview-03", stored: false });
    expect(maxar?.observedAt.toISOString()).toBe("2026-09-03T11:02:00.000Z");
  });
});

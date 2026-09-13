/**
 * Stage 3 exit gate: two collectors end to end, writing provenanced
 * observations under a case authorization, with every refusal exercised.
 *
 * Real Postgres (the derived test database), stubbed network. Skipped without
 * DATABASE_URL like the other database suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { insertObservations, prisma } from "@scout/db";
import { clearStoredObjects, storedObjectKeys } from "./test/network.js";
import { resetObjectStore } from "./v2/storage.js";
import { naiveNormalize } from "./v2/collectors/index.js";

const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

let app: FastifyInstance;
let caseId: string;
let authorizationId: string;
const REF = `V2-STAGE3-${Date.now()}`;
const IN_A_YEAR = new Date(Date.now() + 365 * 86_400_000).toISOString();

const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });
const get = (url: string) => app.inject({ method: "GET", url });

async function newCase(name: string, scope: Array<{ kind: string; value: string }> = []) {
  const r = await post("/cases", { name, authorizationRef: `${REF}-${name}`, scope });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

async function authorize(id: string, overrides: Record<string, unknown> = {}) {
  const r = await post(`/cases/${id}/authorization`, {
    issuedBy: "engagement letter, vitest",
    sourceClasses: ["SENSOR", "PUBLIC_RECORD"],
    actionClasses: ["COLLECT", "READ_GRAPH", "RESOLVE"],
    validUntil: IN_A_YEAR,
    confirmAuthorized: true,
    ...overrides,
  });
  expect(r.statusCode).toBe(201);
  return r.json();
}

run("Scout v2 — stage 3: collection", () => {
  beforeAll(async () => {
    process.env["SEC_EDGAR_USER_AGENT"] = "Scout tests test@example.invalid";
    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();
    caseId = await newCase("stage3", [{ kind: "identifier", value: "Apple Inc." }]);
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  describe("authorization", () => {
    it("refuses collection before the case has an authorization, and says how to fix it", async () => {
      const r = await post("/v2/collect", { caseId, collectorId: "adsb-live" });
      expect(r.statusCode).toBe(403);
      expect(r.json().reason).toBe("authorization-missing");
      expect(r.json().message).toContain(`POST /cases/${caseId}/authorization`);
    });

    it("requires the explicit claim", async () => {
      const r = await post(`/cases/${caseId}/authorization`, {
        issuedBy: "x", sourceClasses: ["SENSOR"], actionClasses: ["COLLECT"], validUntil: IN_A_YEAR,
      });
      expect(r.statusCode).toBe(400);
    });

    it("creates one from the case's scope and records it", async () => {
      const created = await authorize(caseId);
      authorizationId = created.id;
      expect(created.status).toBe("active");
      expect(created.reference).toBe(`${REF}-stage3`);
      expect(created.boundary.scope).toEqual([{ kind: "identifier", value: "Apple Inc." }]);

      const fetched = (await get(`/cases/${caseId}/authorization`)).json();
      expect(fetched.authorization.id).toBe(authorizationId);

      const event = await prisma.auditEvent.findFirst({
        where: { caseId, action: "authorization.created" }, orderBy: { createdAt: "desc" },
      });
      expect(event).not.toBeNull();
      expect((event?.detail as { authorizationId: string }).authorizationId).toBe(authorizationId);
    });
  });

  describe("collectors", () => {
    it("lists both with their licensing terms and configuration state", async () => {
      const body = (await get("/v2/collectors")).json();
      const ids = body.collectors.map((c: { id: string }) => c.id).sort();
      expect(ids).toEqual(expect.arrayContaining(["adsb-live", "sec-edgar"]));
      for (const c of body.collectors) {
        expect(c.licensingTerms.length).toBeGreaterThan(40);
        expect(typeof c.configured).toBe("boolean");
      }
    });
  });

  describe("ADS-B", () => {
    it("writes provenanced observations with identifiers and positions", async () => {
      const r = await post("/v2/collect", { caseId, collectorId: "adsb-live" });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.status).toBe("ok");
      expect(body.written).toBeGreaterThanOrEqual(2);
      expect(body.entityKind).toBe("AIRCRAFT");

      const rows = await prisma.observation.findMany({
        where: { id: { in: body.observationIds } }, include: { identifiers: true },
      });
      expect(rows).toHaveLength(body.written);
      for (const row of rows) {
        expect(row.sourceId).toBe("adsb-live");
        expect(row.authorizationId).toBe(authorizationId);
        expect(row.caseId).toBe(caseId);
        expect(row.collectedAt.getTime()).toBeGreaterThanOrEqual(row.observedAt.getTime());
        expect(row.identifiers.some((i) => i.kind === "ICAO_HEX")).toBe(true);
      }
      const hexes = rows.flatMap((r) => r.identifiers.filter((i) => i.kind === "ICAO_HEX").map((i) => i.normalizedValue));
      expect(hexes).toEqual(expect.arrayContaining(["abc123", "4b1805"]));
      // OpenSky state vectors carry no registration; that comes from the
      // enrichment lookups, which the stub answers empty. The callsign is
      // kept on the payload, and a tail number identifier appears only when
      // a registration was actually reported (covered in collectors.test.ts).
      const callsigns = rows.map((r) => (r.normalizedPayload as { callsign: string | null }).callsign);
      expect(callsigns).toEqual(expect.arrayContaining(["UAL123", "N123AB"]));
      expect(rows.every((r) => r.identifiers.every((i) => i.kind !== "TAIL_NUMBER" || i.normalizedValue.length > 0))).toBe(true);

      const source = await prisma.collectionSource.findUnique({ where: { id: "adsb-live" } });
      expect(source?.licensingTerms).toContain("OpenSky");

      const event = await prisma.auditEvent.findFirst({
        where: { caseId, action: "v2.collection.ran" }, orderBy: { createdAt: "desc" },
      });
      expect((event?.detail as { written: number; outcome: string }).outcome).toBe("ok");
      expect((event?.detail as { written: number }).written).toBe(body.written);
    });

    it("does not write the same fact twice", async () => {
      const r = await post("/v2/collect", { caseId, collectorId: "adsb-live" });
      expect(r.json().written).toBe(0);
      expect(r.json().skipped).toBeGreaterThanOrEqual(2);
    });
  });

  describe("SEC EDGAR", () => {
    it("requires a subject", async () => {
      const r = await post("/v2/collect", { caseId, collectorId: "sec-edgar" });
      expect(r.statusCode).toBe(400);
    });

    it("refuses a subject outside the boundary before fetching anything", async () => {
      const r = await post("/v2/collect", { caseId, collectorId: "sec-edgar", subject: { kind: "company", value: "Microsoft Corp" } });
      expect(r.statusCode).toBe(403);
      expect(r.json().reason).toBe("out-of-scope");
    });

    it("collects a registrant inside the boundary as a public record", async () => {
      const r = await post("/v2/collect", { caseId, collectorId: "sec-edgar", subject: { kind: "company", value: "Apple Inc." } });
      expect(r.statusCode).toBe(200);
      expect(r.json().written).toBe(1);
      const [id] = r.json().observationIds as string[];
      const row = await prisma.observation.findUniqueOrThrow({ where: { id }, include: { identifiers: true } });
      expect(row.sourceId).toBe("sec-edgar");
      expect(row.identifiers.map((i) => [i.kind, i.normalizedValue])).toEqual(
        expect.arrayContaining([["NAME", "apple inc."], ["DOCUMENT_NO", "CIK0000320193"]]),
      );
      expect((row.normalizedPayload as { observedAtBasis: string }).observedAtBasis).toBe("collection");
    });

    it("is inert, not guessing, without its declared User-Agent", async () => {
      const saved = process.env["SEC_EDGAR_USER_AGENT"];
      delete process.env["SEC_EDGAR_USER_AGENT"];
      try {
        const r = await post("/v2/collect", { caseId, collectorId: "sec-edgar", subject: { kind: "company", value: "Apple Inc." } });
        expect(r.json().status).toBe("inert");
        expect(r.json().reason).toBe("not-configured");
      } finally {
        process.env["SEC_EDGAR_USER_AGENT"] = saved;
      }
    });
  });

  describe("reading", () => {
    it("returns observations with positions and logs the read with ids only", async () => {
      const r = await get(`/v2/observations?caseId=${caseId}&limit=50`);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.count).toBeGreaterThanOrEqual(3);
      const aircraft = body.observations.find((o: { sourceId: string }) => o.sourceId === "adsb-live");
      expect(aircraft.position).not.toBeNull();
      expect(aircraft.rawPayload).toBeUndefined();

      const log = await prisma.accessLog.findFirst({
        where: { authorizationId, targetType: "Observation" }, orderBy: { createdAt: "desc" },
      });
      expect(log?.resultCount).toBe(body.count);
      expect(log?.targetIds.sort()).toEqual(body.observations.map((o: { id: string }) => o.id).sort());
      expect(log?.queryText).toBeNull();
    });

    it("returns the raw payload only when asked", async () => {
      const body = (await get(`/v2/observations?caseId=${caseId}&limit=1&raw=true`)).json();
      expect(body.observations[0].rawPayload).toBeDefined();
    });
  });

  describe("refusals", () => {
    it("refuses COLLECT when the authorization only permits reads", async () => {
      const id = await newCase("read-only");
      await authorize(id, { actionClasses: ["READ_GRAPH"] });
      const r = await post("/v2/collect", { caseId: id, collectorId: "adsb-live" });
      expect(r.statusCode).toBe(403);
      expect(r.json().reason).toBe("action-not-permitted");
    });

    it("refuses a source class the authorization does not list", async () => {
      const id = await newCase("records-only");
      await authorize(id, { sourceClasses: ["PUBLIC_RECORD"] });
      const r = await post("/v2/collect", { caseId: id, collectorId: "adsb-live" });
      expect(r.statusCode).toBe(403);
      expect(r.json().reason).toBe("source-class-not-permitted");
    });

    it("refuses an entity kind outside the boundary", async () => {
      const id = await newCase("people-only");
      await authorize(id, { entityKinds: ["PERSON"] });
      const r = await post("/v2/collect", { caseId: id, collectorId: "adsb-live" });
      expect(r.statusCode).toBe(403);
      expect(r.json().reason).toBe("out-of-scope");
      expect(r.json().message).toContain("AIRCRAFT");
    });

    it("refuses an expired authorization", async () => {
      const id = await newCase("expired");
      await authorize(id, {
        validFrom: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        validUntil: new Date(Date.now() - 86_400_000).toISOString(),
      });
      const r = await post("/v2/collect", { caseId: id, collectorId: "adsb-live" });
      expect(r.statusCode).toBe(403);
      expect(r.json().reason).toBe("authorization-expired");
    });

    it("stops collection and reads the moment an authorization is revoked", async () => {
      const id = await newCase("revoked");
      await authorize(id);
      expect((await post("/v2/collect", { caseId: id, collectorId: "adsb-live" })).json().status).toBe("ok");

      const revoke = await post(`/cases/${id}/authorization/revoke`, { reason: "client withdrew consent" });
      expect(revoke.statusCode).toBe(200);
      expect(revoke.json().status).toBe("revoked");

      const collect = await post("/v2/collect", { caseId: id, collectorId: "adsb-live" });
      expect(collect.statusCode).toBe(403);
      expect(collect.json().reason).toBe("authorization-revoked");

      const read = await get(`/v2/observations?caseId=${id}`);
      expect(read.statusCode).toBe(403);
      expect(read.json().reason).toBe("authorization-revoked");

      const event = await prisma.auditEvent.findFirst({ where: { caseId: id, action: "authorization.revoked" } });
      expect((event?.detail as { reason: string }).reason).toBe("client withdrew consent");
    });

    it("refuses an unknown collector", async () => {
      const r = await post("/v2/collect", { caseId, collectorId: "does-not-exist" });
      expect(r.statusCode).toBe(404);
    });
  });

  describe("resolution", () => {
    const stamp = Date.now();
    const ids: Record<string, string> = {};

    async function seed(name: string, identifiers: { kind: string; value: string }[]) {
      const [id] = await insertObservations([{
        sourceId: "adsb-live", authorizationId, caseId,
        collectedAt: new Date(), observedAt: new Date(),
        rawPayload: { seeded: name }, normalizedPayload: { seeded: name, stamp },
        contentHash: `${name}-${stamp}`, position: null, confidenceBp: null, indeterminate: false, entityKind: "AIRCRAFT",
      }]);
      await prisma.identifier.createMany({
        data: identifiers.map((i) => ({ observationId: id as string, kind: i.kind as never, value: i.value, normalizedValue: naiveNormalize(i.kind as never, i.value), normalizationVersion: "naive-1" })),
      });
      ids[name] = id as string;
    }

    beforeAll(async () => {
      await seed("A1", [{ kind: "ICAO_HEX", value: "a1b2c3" }, { kind: "TAIL_NUMBER", value: "N111AA" }]);
      await seed("A2", [{ kind: "ICAO_HEX", value: "A1B2C3" }]);
      await seed("A3", [{ kind: "TAIL_NUMBER", value: "N222BB" }, { kind: "NAME", value: "Skyhawk" }]);
      await seed("A4", [{ kind: "ICAO_HEX", value: "ffffff" }, { kind: "NAME", value: "Skyhawk" }]);
    });

    it("refuses without RESOLVE", async () => {
      const id = await newCase("no-resolve");
      await authorize(id, { actionClasses: ["COLLECT", "READ_GRAPH"] });
      const r = await post("/v2/resolve", { caseId: id, entityKind: "AIRCRAFT" });
      expect(r.statusCode).toBe(403);
      expect(r.json().reason).toBe("action-not-permitted");
    });

    it("resolves aircraft into entities and records every pair", async () => {
      const r = await post("/v2/resolve", { caseId, entityKind: "AIRCRAFT" });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.modelVersion).toBe("stub-resolver-1");
      expect(body.counts.match).toBe(1);
      expect(body.counts.review).toBe(1);

      const merged = body.entities.find((e: { members: string[] }) => e.members.includes(ids["A1"] as string));
      expect(merged.status).toBe("RESOLVED");
      expect(merged.members.sort()).toEqual([ids["A1"], ids["A2"]].sort());

      const run = await prisma.resolutionRun.findUniqueOrThrow({ where: { id: body.runId } });
      expect(run.status).toBe("COMPLETE");
      expect(run.pairsEvaluated).toBe(2);
      const decisions = await prisma.matchDecision.findMany({ where: { runId: body.runId } });
      expect(decisions.map((d) => d.decision).sort()).toEqual(["MATCH", "REVIEW"]);

      const event = await prisma.auditEvent.findFirst({ where: { caseId, action: "v2.resolution.ran" }, orderBy: { createdAt: "desc" } });
      expect((event?.detail as { runId: string }).runId).toBe(body.runId);
    });

    it("lists the review band and logs the read", async () => {
      const r = await get(`/v2/review?caseId=${caseId}&kind=AIRCRAFT`);
      expect(r.statusCode).toBe(200);
      expect(r.json().count).toBe(1);
      const [pair] = r.json().pairs;
      expect([pair.left.id, pair.right.id].sort()).toEqual([ids["A3"], ids["A4"]].sort());
      expect(pair.scoreBp).toBe(8000);
      expect(pair.kind).toBe("AIRCRAFT");
      const summary = r.json().kinds.find((k: { kind: string }) => k.kind === "AIRCRAFT");
      expect(summary.open).toBe(1);
      expect(summary.adjudicatedSinceRun).toBe(0);
      expect(typeof summary.modelVersion).toBe("string");
      const log = await prisma.accessLog.findFirst({ where: { authorizationId, targetType: "MatchDecision" }, orderBy: { createdAt: "desc" } });
      expect(log?.targetIds).toEqual([pair.decisionId]);
    });

    it("lets a pin outrank the model, supersedes memberships, and keeps the history", async () => {
      const pin = await post("/v2/adjudicate", {
        caseId, leftObservationId: ids["A2"], rightObservationId: ids["A1"], decision: "NON_MATCH", note: "different airframes, hex reused",
      });
      expect(pin.statusCode).toBe(201);
      expect(pin.json().pairKey).toBe([ids["A1"], ids["A2"]].sort().join("|"));

      // The queue says a decision is waiting to be applied, until the run applies it.
      const waiting = (await get(`/v2/review?caseId=${caseId}&kind=AIRCRAFT`)).json().kinds[0];
      expect(waiting.adjudicatedSinceRun).toBe(1);

      const r = await post("/v2/resolve", { caseId, entityKind: "AIRCRAFT" });
      const body = r.json();
      expect(body.counts.pinned).toBe(1);
      const forA1 = body.entities.find((e: { members: string[] }) => e.members.includes(ids["A1"] as string));
      const forA2 = body.entities.find((e: { members: string[] }) => e.members.includes(ids["A2"] as string));
      expect(forA1.id).not.toBe(forA2.id);
      expect(forA1.status).toBe("PROVISIONAL");
      expect((await get(`/v2/review?caseId=${caseId}&kind=AIRCRAFT`)).json().kinds[0].adjudicatedSinceRun).toBe(0);

      const pinned = await prisma.matchDecision.findFirst({ where: { runId: body.runId, leftObservationId: [ids["A1"], ids["A2"]].sort()[0] } });
      expect(pinned?.decision).toBe("NON_MATCH");
      expect((pinned?.featureVector as { pinned: boolean }).pinned).toBe(true);

      // Nothing deleted: the old membership is superseded by this run.
      const memberships = await prisma.entityMember.findMany({ where: { observationId: ids["A1"] }, orderBy: { addedAt: "asc" } });
      expect(memberships.length).toBeGreaterThanOrEqual(2);
      expect(memberships[0]?.supersededBy).toBe(body.runId);
      expect(memberships[memberships.length - 1]?.supersededAt).toBeNull();
      const old = await prisma.entity.findUniqueOrThrow({ where: { id: memberships[0]?.entityId as string } });
      expect(old.status).toBe("UNRESOLVED");

      const event = await prisma.auditEvent.findFirst({ where: { caseId, action: "v2.adjudicated" } });
      expect((event?.detail as { decision: string }).decision).toBe("NON_MATCH");
    });

    it("merges a review pair the analyst confirms", async () => {
      await post("/v2/adjudicate", { caseId, leftObservationId: ids["A3"], rightObservationId: ids["A4"], decision: "MATCH", note: "same aircraft, re-registered" });
      const body = (await post("/v2/resolve", { caseId, entityKind: "AIRCRAFT" })).json();
      const merged = body.entities.find((e: { members: string[] }) => e.members.includes(ids["A3"] as string));
      expect(merged.status).toBe("RESOLVED");
      expect(merged.members.sort()).toEqual([ids["A3"], ids["A4"]].sort());
      expect((await get(`/v2/review?caseId=${caseId}&kind=AIRCRAFT`)).json().count).toBe(0);
    });

    it("reads entities with their sources and logs it", async () => {
      const r = await get(`/v2/entities?caseId=${caseId}&kind=AIRCRAFT`);
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.count).toBeGreaterThanOrEqual(4);
      for (const e of body.entities) {
        expect(e.sourceIds.length).toBeGreaterThan(0);
        expect(e.members.every((m: { addedBy: string }) => m.addedBy === "SYSTEM")).toBe(true);
      }
      // Every registered collector is listed, with zero when it had nothing
      // to say, plus every source that actually wrote observations here.
      const sources = body.sources as Array<{ sourceId: string; observations: number }>;
      expect(sources.map((s) => s.sourceId)).toEqual(expect.arrayContaining(["adsb-live", "sec-edgar"]));
      const written = await prisma.observation.groupBy({ by: ["sourceId"], where: { authorizationId }, _count: { _all: true } });
      for (const w of written) expect(sources.find((s) => s.sourceId === w.sourceId)?.observations).toBe(w._count._all);
      expect(sources.some((s) => s.observations > 0)).toBe(true);
      const log = await prisma.accessLog.findFirst({ where: { authorizationId, targetType: "Entity" }, orderBy: { createdAt: "desc" } });
      expect(log?.resultCount).toBe(body.count);
    });

    it("refuses an adjudication about an observation outside the authorization", async () => {
      const r = await post("/v2/adjudicate", { caseId, leftObservationId: ids["A1"], rightObservationId: "obs_not_ours", decision: "MATCH", note: "x" });
      expect(r.statusCode).toBe(404);
    });
  });

  describe("stage 9: connectors and imagery", () => {
    let nineCase: string;
    let nineAuth: string;
    const box = [5.3, 60.39, 5.32, 60.4];
    const window = { from: "2026-08-20T00:00:00Z", to: "2026-09-10T00:00:00Z" };

    beforeAll(async () => {
      nineCase = await newCase("stage9", [{ kind: "domain", value: "example.org" }, { kind: "domain", value: "closed.example" }]);
      nineAuth = (await authorize(nineCase, {
        sourceClasses: ["SENSOR", "PUBLIC_RECORD", "OPEN_WEB", "FIRST_PARTY", "SATELLITE"],
        entityKinds: ["VESSEL", "DEVICE", "ORG", "LOCATION", "PERSON"],
      })).id;
      process.env["S3_ENDPOINT"] = "http://127.0.0.1:9000";
      process.env["S3_ACCESS_KEY"] = "test";
      process.env["S3_SECRET_KEY"] = "test";
      process.env["S3_BUCKET_TILES"] = "scout-tiles-test";
      resetObjectStore();
      clearStoredObjects();
    });

    it("collects AIS vessels from the national feeds with attribution on the row", async () => {
      const r = await post("/v2/collect", { caseId: nineCase, collectorId: "ais-live" });
      expect(r.statusCode).toBe(200);
      expect(r.json().written).toBe(1);
      const row = await prisma.observation.findUnique({ where: { id: r.json().observationIds[0] }, include: { identifiers: true } });
      expect(row?.entityKind).toBe("VESSEL");
      expect((row?.normalizedPayload as { upstream: string }).upstream).toBe("Kystverket (Norway)");
      expect(row?.identifiers.map((i) => i.kind).sort()).toEqual(["IMO", "MMSI", "NAME"]);
      expect(row?.observedAt.toISOString()).toBe("2026-09-13T11:58:00.000Z");
    });

    it("ingests first-party telemetry under a consent reference, and refuses without one", async () => {
      const refused = await post("/v2/collect", { caseId: nineCase, collectorId: "first-party-telemetry", params: { deviceId: "truck-12", points: [{ at: "2026-09-13T10:00:00Z", lon: 5, lat: 60 }] } });
      expect(refused.statusCode).toBe(400);
      const r = await post("/v2/collect", { caseId: nineCase, collectorId: "first-party-telemetry", params: { consentRef: "CONSENT-77", deviceId: "truck-12", points: [{ at: "2026-09-13T10:00:00Z", lon: 5, lat: 60 }, { at: "2026-09-13T10:05:00Z", lon: 5.01, lat: 60.01, speedKn: 9 }] } });
      expect(r.statusCode).toBe(200);
      expect(r.json().written).toBe(2);
      const ids = await prisma.identifier.findMany({ where: { observationId: { in: r.json().observationIds } } });
      expect(ids.every((i) => i.kind === "DEVICE_ID" && i.value === "truck-12")).toBe(true);
    });

    it("fetches one open-web page under a covered domain, obeying robots.txt", async () => {
      const r = await post("/v2/collect", { caseId: nineCase, collectorId: "open-web", subject: { kind: "domain", value: "example.org" } });
      expect(r.statusCode).toBe(200);
      expect(r.json().written).toBe(1);
      const row = await prisma.observation.findUnique({ where: { id: r.json().observationIds[0] }, include: { identifiers: true } });
      expect(row?.identifiers.map((i) => `${i.kind}:${i.value}`)).toEqual(expect.arrayContaining(["DOMAIN:example.org", "EMAIL:hello@example.org", "HANDLE:@examplesons", "NAME:Example & Sons"]));

      const closed = await post("/v2/collect", { caseId: nineCase, collectorId: "open-web", subject: { kind: "domain", value: "closed.example" } });
      expect(closed.statusCode).toBe(200);
      expect(closed.json().status).toBe("error");
      expect(closed.json().message).toMatch(/robots\.txt disallows/);
      const outside = await post("/v2/collect", { caseId: nineCase, collectorId: "open-web", subject: { kind: "domain", value: "elsewhere.example" } });
      expect(outside.statusCode).toBe(403);
    });

    it("is inert for the satellite catalogues without their keys", async () => {
      for (const collectorId of ["sentinel-2", "planet-scenes", "maxar-catalog"]) {
        const r = await post("/v2/collect", { caseId: nineCase, collectorId, params: { bbox: box, ...window } });
        expect(r.statusCode).toBe(200);
        expect(r.json().status).toBe("inert");
      }
    });

    it("refuses a box too large for one request before touching a provider", async () => {
      process.env["SENTINELHUB_CLIENT_ID"] = "id";
      process.env["SENTINELHUB_CLIENT_SECRET"] = "secret";
      const r = await post("/v2/collect", { caseId: nineCase, collectorId: "sentinel-2", params: { bbox: [5, 60, 6, 61], ...window } });
      expect(r.statusCode).toBe(400);
    });

    it("stores each Sentinel-2 scene over the box once, indexes it, and serves the preview", async () => {
      const first = await post("/v2/collect", { caseId: nineCase, collectorId: "sentinel-2", params: { bbox: box, ...window, maxScenes: 2 } });
      expect(first.statusCode).toBe(200);
      expect(first.json().written).toBe(2);
      const keys = storedObjectKeys();
      expect(keys.filter((k) => k.endsWith(".tif"))).toHaveLength(2);
      expect(keys.filter((k) => k.endsWith(".png"))).toHaveLength(2);
      expect(keys.every((k) => k.startsWith("http://127.0.0.1:9000/scout-tiles-test/sentinel-2/"))).toBe(true);
      const tiles = await prisma.imageryTile.findMany({ where: { authorizationId: nineAuth } });
      expect(tiles).toHaveLength(2);
      expect(tiles.every((t) => t.cloudOptimized === false && t.previewKey !== null && t.resolutionM === 10)).toBe(true);
      const obs = await prisma.observation.findUnique({ where: { id: first.json().observationIds[0] } });
      expect(obs?.entityKind).toBe("LOCATION");
      expect((obs?.normalizedPayload as { tileId: string }).tileId).toBe(tiles.find((t) => t.sceneId === (obs?.normalizedPayload as { sceneId: string }).sceneId)?.id);

      // The same request again: nothing fetched, nothing written, same rows.
      const again = await post("/v2/collect", { caseId: nineCase, collectorId: "sentinel-2", params: { bbox: box, ...window, maxScenes: 2 } });
      expect(again.json().written).toBe(0);
      expect(again.json().skipped).toBe(2);
      expect(storedObjectKeys()).toEqual(keys);
      expect(await prisma.imageryTile.count({ where: { authorizationId: nineAuth } })).toBe(2);

      const listed = await get(`/v2/imagery/tiles?caseId=${nineCase}&bbox=5.31,60.395,5.315,60.398`);
      expect(listed.json().count).toBe(2);
      const far = await get(`/v2/imagery/tiles?caseId=${nineCase}&bbox=10,50,11,51`);
      expect(far.json().count).toBe(0);
      const log = await prisma.accessLog.findFirst({ where: { authorizationId: nineAuth, targetType: "ImageryTile" }, orderBy: { createdAt: "desc" } });
      expect(log).not.toBeNull();

      const tile = tiles[0] as { id: string };
      const preview = await get(`/v2/imagery/preview/${tile.id}?caseId=${nineCase}`);
      expect(preview.statusCode).toBe(200);
      expect(preview.headers["content-type"]).toBe("image/png");
      expect(preview.rawPayload.subarray(1, 4).toString()).toBe("PNG");

      // Another case's authorization: the tile is not there.
      const other = await newCase("stage9-other");
      await authorize(other, { sourceClasses: ["SATELLITE"], entityKinds: ["LOCATION"] });
      expect((await get(`/v2/imagery/preview/${tile.id}?caseId=${other}`)).statusCode).toBe(404);
      expect((await get(`/v2/imagery/tiles?caseId=${other}`)).json().count).toBe(0);
    });

    it("records Planet and Maxar catalogue scenes as metadata when keyed", async () => {
      process.env["PLANET_API_KEY"] = "pk";
      process.env["MAXAR_API_KEY"] = "mk";
      const planet = await post("/v2/collect", { caseId: nineCase, collectorId: "planet-scenes", params: { bbox: box, ...window } });
      expect(planet.json().written).toBe(1);
      const maxar = await post("/v2/collect", { caseId: nineCase, collectorId: "maxar-catalog", params: { bbox: box, ...window } });
      expect(maxar.json().written).toBe(1);
      const rows = await prisma.observation.findMany({ where: { id: { in: [...planet.json().observationIds, ...maxar.json().observationIds] } } });
      expect(rows.map((r) => (r.normalizedPayload as { provider: string; stored: boolean }).provider).sort()).toEqual(["maxar", "planet"]);
      expect(rows.every((r) => (r.normalizedPayload as { stored: boolean }).stored === false)).toBe(true);
      expect(storedObjectKeys().some((k) => k.includes("planet") || k.includes("maxar"))).toBe(false);
      delete process.env["PLANET_API_KEY"];
      delete process.env["MAXAR_API_KEY"];
      delete process.env["SENTINELHUB_CLIENT_ID"];
      delete process.env["SENTINELHUB_CLIENT_SECRET"];
    });
  });

  describe("stage 10: recognition, gallery-restricted", () => {
    let recCase: string;
    let recAuth: string;
    let openCase: string;
    let gallery: string;
    let entityA: string;
    let entityB: string;
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const IN_A_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();

    beforeAll(async () => {
      recCase = await newCase("stage10");
      recAuth = (await authorize(recCase, { sourceClasses: ["SENSOR", "FIRST_PARTY"], actionClasses: ["COLLECT", "READ_GRAPH", "RESOLVE", "BIOMETRIC_COMPARE"], entityKinds: ["PERSON", "DEVICE"] })).id;
      openCase = await newCase("stage10-noncompare");
      await authorize(openCase, { actionClasses: ["COLLECT", "READ_GRAPH"] });
      // Two people to enrol, from first-party observations resolved into entities.
      await post("/v2/collect", { caseId: recCase, collectorId: "first-party-telemetry", params: { consentRef: "CONSENT-1", deviceId: "badge-a", label: "Ann Example", points: [{ at: "2026-09-13T10:00:00Z", lon: 5, lat: 60 }] } });
      await post("/v2/collect", { caseId: recCase, collectorId: "first-party-telemetry", params: { consentRef: "CONSENT-1", deviceId: "badge-b", label: "Ben Example", points: [{ at: "2026-09-13T10:00:00Z", lon: 6, lat: 61 }] } });
      const resolved = (await post("/v2/resolve", { caseId: recCase, entityKind: "DEVICE" })).json();
      const ents = resolved.entities as Array<{ id: string; label?: string; canonicalLabel?: string }>;
      expect(ents.length).toBe(2);
      entityA = ents[0]!.id;
      entityB = ents[1]!.id;
      delete process.env["RECOGNITION_ENABLED"];
      process.env["RECOGNITION_TEMPLATE_KEY"] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    });

    it("has no comparison route without a gallery, and refuses everything while disabled, with an audit event", async () => {
      expect((await post("/v2/compare", { caseId: recCase, modality: "FACE", mediaB64: b64("face A") })).statusCode).toBe(400);
      const created = await post("/v2/galleries", { name: "Staff", purpose: "Access control for the enrolled staff of the customer", custodianOrg: "Customer Security", lawfulBasis: "EMPLOYMENT", lawfulBasisDocumentRef: "HR-POLICY-7", reviewDueAt: IN_A_MONTH, confirmLawfulBasis: true });
      expect(created.statusCode).toBe(201);
      gallery = created.json().id;
      const r = await post("/v2/compare", { caseId: recCase, galleryId: gallery, modality: "FACE", mediaB64: b64("face A") });
      expect(r.statusCode).toBe(503);
      expect(r.json().code ?? r.json().error).toBe("feature-disabled");
      const event = await prisma.auditEvent.findFirst({ where: { caseId: recCase, action: "v2.biometric.comparison" }, orderBy: { createdAt: "desc" } });
      expect((event?.detail as { outcome: string }).outcome).toBe("refused");
    });

    it("refuses a gallery without a lawful basis document or a future review date", async () => {
      expect((await post("/v2/galleries", { name: "x", purpose: "some purpose here", custodianOrg: "o", lawfulBasis: "CONSENT", reviewDueAt: IN_A_MONTH, confirmLawfulBasis: true })).statusCode).toBe(400);
      expect((await post("/v2/galleries", { name: "x", purpose: "some purpose here", custodianOrg: "o", lawfulBasis: "CONSENT", lawfulBasisDocumentRef: "D-1", reviewDueAt: IN_A_MONTH })).statusCode).toBe(400);
      expect((await post("/v2/galleries", { name: "x", purpose: "some purpose here", custodianOrg: "o", lawfulBasis: "CONSENT", lawfulBasisDocumentRef: "D-1", reviewDueAt: "2020-01-01T00:00:00Z", confirmLawfulBasis: true })).statusCode).toBe(400);
    });

    it("refuses to enrol scraped or undocumented media, and audits the refusal", async () => {
      process.env["RECOGNITION_ENABLED"] = "true";
      const scraped = await post(`/v2/galleries/${gallery}/enroll`, { caseId: recCase, entityId: entityA, modality: "FACE", mediaB64: b64("face A"), origin: "open-web", lawfulBasisDocumentRef: "HR-7", expiresAt: IN_A_MONTH });
      expect(scraped.statusCode).toBe(403);
      expect(scraped.json().prohibition).toBe("OPEN_WORLD_BIOMETRICS");
      const event = await prisma.auditEvent.findFirst({ where: { caseId: recCase, action: "v2.gallery.enrollment" }, orderBy: { createdAt: "desc" } });
      expect((event?.detail as { outcome: string; origin: string }).outcome).toBe("refused");
      expect((event?.detail as { origin: string }).origin).toBe("open-web");
      expect(await prisma.galleryEnrollment.count({ where: { galleryId: gallery } })).toBe(0);
      expect(await prisma.biometricTemplate.count({ where: { galleryId: gallery } })).toBe(0);
    });

    it("enrols consented media as an encrypted template and keeps no media", async () => {
      const r = await post(`/v2/galleries/${gallery}/enroll`, { caseId: recCase, entityId: entityA, modality: "FACE", mediaB64: b64("face A"), contentType: "image/png", origin: "consented-upload", lawfulBasisDocumentRef: "CONSENT-FORM-A", expiresAt: IN_A_MONTH });
      expect(r.statusCode).toBe(201);
      const enrollment = await prisma.galleryEnrollment.findUnique({ where: { id: r.json().enrollment.id } });
      expect(enrollment?.lawfulBasisDocumentRef).toBe("CONSENT-FORM-A");
      const template = await prisma.biometricTemplate.findUnique({ where: { id: enrollment?.templateRef ?? "" } });
      expect(template?.dims).toBe(16);
      // The stored bytes are not the vector: no float32 of the embedding appears in the ciphertext.
      const plain = Buffer.from(new Float32Array(JSON.parse(JSON.stringify([0.1]))).buffer);
      expect(Buffer.from(template!.ciphertext).includes(plain)).toBe(false);
      expect(Buffer.from(template!.ciphertext).length).toBe(16 * 4);
      expect(template?.keyId).toHaveLength(12);
      const event = await prisma.auditEvent.findFirst({ where: { caseId: recCase, action: "v2.gallery.enrollment", detail: { path: ["outcome"], equals: "ok" } }, orderBy: { createdAt: "desc" } });
      expect((event?.detail as { mediaHash: string }).mediaHash).toHaveLength(64);
      // The media itself is nowhere: not an observation, not an object.
      expect(await prisma.observation.count({ where: { authorizationId: recAuth, sourceId: { contains: "gallery" } } })).toBe(0);
      expect(storedObjectKeys().some((k) => k.includes("face"))).toBe(false);
    });

    it("refuses a comparison from an authorization without BIOMETRIC_COMPARE, with an audit event", async () => {
      const r = await post("/v2/compare", { caseId: openCase, galleryId: gallery, modality: "FACE", mediaB64: b64("face A") });
      expect(r.statusCode).toBe(403);
      expect(r.json().prohibition).toBe("OPEN_WORLD_BIOMETRICS");
      const event = await prisma.auditEvent.findFirst({ where: { caseId: openCase, action: "v2.biometric.comparison" }, orderBy: { createdAt: "desc" } });
      expect((event?.detail as { outcome: string }).outcome).toBe("refused");
      expect(await prisma.biometricComparison.count({ where: { galleryId: gallery } })).toBe(0);
    });

    it("matches the enrolled person, says NO_MATCH for a stranger, logs both, and never picks a close call", async () => {
      const same = await post("/v2/compare", { caseId: recCase, galleryId: gallery, modality: "FACE", mediaB64: b64("face A") });
      expect(same.statusCode).toBe(200);
      expect(same.json().decision).toBe("MATCH");
      expect(same.json().matches[0]).toMatchObject({ entityId: entityA, distanceBp: 0, withinThreshold: true });
      expect(same.json().matches[0].label).toBeTruthy();

      const stranger = await post("/v2/compare", { caseId: recCase, galleryId: gallery, modality: "FACE", mediaB64: b64("face Z") });
      expect(stranger.json().decision).toBe("NO_MATCH");
      expect(stranger.json().matches[0].withinThreshold).toBe(false);

      // A second identity enrolled from the same media: the probe now sits
      // between two candidates inside the margin, so the answer is neither.
      await post(`/v2/galleries/${gallery}/enroll`, { caseId: recCase, entityId: entityB, modality: "FACE", mediaB64: b64("face A"), origin: "consented-upload", lawfulBasisDocumentRef: "CONSENT-FORM-B", expiresAt: IN_A_MONTH });
      const twins = await post("/v2/compare", { caseId: recCase, galleryId: gallery, modality: "FACE", mediaB64: b64("face A") });
      expect(twins.json().decision).toBe("INDETERMINATE");
      expect(twins.json().reason).toMatch(/margin/);

      const logged = await prisma.biometricComparison.findMany({ where: { galleryId: gallery }, orderBy: { requestedAt: "asc" } });
      expect(logged.map((c) => c.decision)).toEqual(["MATCH", "NO_MATCH", "INDETERMINATE"]);
      expect(logged.every((c) => c.probeHash.length === 64 && c.authorizationId === recAuth && c.requestedBy.length > 0)).toBe(true);
      // Immutable: the log cannot be edited after the fact.
      await expect(prisma.biometricComparison.update({ where: { id: logged[0]!.id }, data: { decision: "NO_MATCH" } })).rejects.toThrow();
    });

    it("ignores revoked and expired enrollments, and refuses a gallery whose review is overdue", async () => {
      const enrollments = await prisma.galleryEnrollment.findMany({ where: { galleryId: gallery }, orderBy: { enrolledAt: "asc" } });
      const revoke = await post(`/v2/galleries/${gallery}/enrollments/${enrollments[1]!.id}/revoke`, { reason: "consent withdrawn" });
      expect(revoke.statusCode).toBe(200);
      const after = await post("/v2/compare", { caseId: recCase, galleryId: gallery, modality: "FACE", mediaB64: b64("face A") });
      expect(after.json().decision).toBe("MATCH");
      expect(after.json().compared).toBe(1);

      await prisma.gallery.update({ where: { id: gallery }, data: { reviewDueAt: new Date(Date.now() - 1000) } });
      const overdue = await post("/v2/compare", { caseId: recCase, galleryId: gallery, modality: "FACE", mediaB64: b64("face A") });
      expect(overdue.statusCode).toBe(409);
      const listed = (await get("/v2/galleries")).json();
      expect(listed.galleries.find((g: { id: string }) => g.id === gallery).reviewOverdue).toBe(true);
      delete process.env["RECOGNITION_ENABLED"];
    });
  });

  describe("links and the temporal graph", () => {
    let graphCase: string;
    let graphAuth: string;
    const T0 = new Date(Date.now() - 2 * 60 * 60_000);
    const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
    const obs: Record<string, string> = {};
    const ent: Record<string, string> = {};

    async function place(name: string, identifiers: { kind: string; value: string }[], observedAt: Date, position: { lon: number; lat: number } | null) {
      const [id] = await insertObservations([{
        sourceId: "adsb-live", authorizationId: graphAuth, caseId: graphCase, collectedAt: new Date(), observedAt,
        rawPayload: { seeded: name }, normalizedPayload: { seeded: name, graph: T0.getTime() },
        contentHash: `graph-${name}-${T0.getTime()}`, position, confidenceBp: null, indeterminate: false, entityKind: "PERSON",
      }]);
      await prisma.identifier.createMany({
        data: identifiers.map((i) => ({ observationId: id as string, kind: i.kind as never, value: i.value, normalizedValue: naiveNormalize(i.kind as never, i.value), normalizationVersion: "naive-1" })),
      });
      obs[name] = id as string;
    }

    beforeAll(async () => {
      graphCase = await newCase("graph");
      graphAuth = (await authorize(graphCase)).id;
      const portland = { lon: -122.676, lat: 45.523 };
      await place("P1a", [{ kind: "PHONE", value: "+14155550100" }, { kind: "DEVICE_ID", value: "dev-1" }], at(0), portland);
      await place("P1b", [{ kind: "PHONE", value: "(415) 555-0100" }, { kind: "NAME", value: "Bob Smith" }], at(5), { lon: -122.677, lat: 45.524 });
      await place("P2", [{ kind: "DEVICE_ID", value: "dev-1" }, { kind: "NAME", value: "Alice Jones" }, { kind: "EMAIL", value: "alice@example.org" }], at(60), { lon: -63.573, lat: 44.649 });
      // ~500 m from P1b, three minutes later.
      await place("P3", [{ kind: "NAME", value: "Carol Diaz" }, { kind: "EMAIL", value: "carol@example.org" }], at(8), { lon: -122.671, lat: 45.526 });
      // Same minute, fifty kilometres away.
      await place("P4", [{ kind: "NAME", value: "Dan Roe" }], at(9), { lon: -122.1, lat: 45.9 });

      // The device is shared by two different people: a pinned non-match keeps
      // the stand-in resolver from merging them on it.
      await post("/v2/adjudicate", { caseId: graphCase, leftObservationId: obs["P1a"], rightObservationId: obs["P2"], decision: "NON_MATCH", note: "shared household device" });
      const resolved = (await post("/v2/resolve", { caseId: graphCase, entityKind: "PERSON" })).json();
      for (const e of resolved.entities as { id: string; members: string[] }[]) {
        for (const [name, id] of Object.entries(obs)) if (e.members.includes(id)) ent[name] = e.id;
      }
      expect(ent["P1a"]).toBe(ent["P1b"]);
      expect(ent["P2"]).not.toBe(ent["P1a"]);
    });

    it("derives shared-device and co-location edges with evidence and windows", async () => {
      const r = await post("/v2/links/derive", { caseId: graphCase, radiusM: 2000, windowMinutes: 30 });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.created).toBe(2);
      expect(body.byBasis).toEqual({ "shared:DEVICE_ID": 1, "co-location:2000m/30min": 1 });

      const device = body.edges.find((e: { relation: string }) => e.relation === "SAME_DEVICE");
      expect([device.fromEntityId, device.toEntityId].sort()).toEqual([ent["P1a"], ent["P2"]].sort());
      expect(device.evidenceObservationIds).toEqual(expect.arrayContaining([obs["P1a"], obs["P2"]]));
      expect(device.validUntil).toBeNull();

      // Both of E1's sightings are within reach of P3, so one window covers
      // them: from the first sighting to the last plus the window.
      expect(device.basis).toBe("shared:DEVICE_ID");
      const near = body.edges.find((e: { relation: string }) => e.relation === "CO_LOCATED");
      expect([near.fromEntityId, near.toEntityId].sort()).toEqual([ent["P1b"], ent["P3"]].sort());
      expect(new Date(near.validFrom).getTime()).toBe(at(0).getTime());
      expect(new Date(near.validUntil).getTime()).toBe(at(8 + 30).getTime());
      expect(near.evidenceObservationIds.sort()).toEqual([obs["P1a"], obs["P1b"], obs["P3"]].sort());
      expect(near.confidenceBp).toBeGreaterThan(8000);
      expect(body.edges.some((e: { fromEntityId: string; toEntityId: string }) => e.fromEntityId === ent["P4"] || e.toEntityId === ent["P4"])).toBe(false);

      const event = await prisma.auditEvent.findFirst({ where: { caseId: graphCase, action: "v2.links.derived" } });
      expect(event).not.toBeNull();
    });

    it("keeps the same edges on a re-run instead of duplicating them", async () => {
      const body = (await post("/v2/links/derive", { caseId: graphCase })).json();
      expect(body.created).toBe(0);
      expect(body.kept).toBe(2);
      expect(body.superseded).toBe(0);
    });

    it("answers neighbours on both clocks", async () => {
      // Now: the shared device still holds; the co-location ended an hour ago.
      const now = (await get(`/v2/graph/neighbors?caseId=${graphCase}&entityId=${ent["P1a"]}&hops=1`)).json();
      expect(now.nodes.map((n: { id: string }) => n.id).sort()).toEqual([ent["P1a"], ent["P2"]].sort());
      expect(now.edges).toHaveLength(1);

      // At T0+20min, given everything known today: both held.
      const then = (await get(`/v2/graph/neighbors?caseId=${graphCase}&entityId=${ent["P1a"]}&asOf=${at(20).toISOString()}`)).json();
      expect(then.nodes.map((n: { id: string }) => n.id).sort()).toEqual([ent["P1a"], ent["P2"], ent["P3"]].sort());
      expect(then.edges).toHaveLength(2);

      // At T0+20min, as it was known at T0+20min: nothing had been learned.
      // The entity itself did not exist yet, so the answer is 404, not an
      // empty graph pretending the entity was there.
      const strict = await get(`/v2/graph/neighbors?caseId=${graphCase}&entityId=${ent["P1a"]}&asOf=${at(20).toISOString()}&knownAs=${at(20).toISOString()}`);
      expect(strict.statusCode).toBe(404);

      // The last logged read is the T0+20 one: three nodes, ids recorded.
      const log = await prisma.accessLog.findFirst({ where: { authorizationId: graphAuth, queryText: { startsWith: "neighbors" } }, orderBy: { createdAt: "desc" } });
      expect(log?.resultCount).toBe(3);
      expect(log?.targetIds.sort()).toEqual(then.nodes.map((n: { id: string }) => n.id).sort());
    });

    it("finds a path within the hop cap and none beyond it", async () => {
      const at20 = at(20).toISOString();
      const two = (await get(`/v2/graph/path?caseId=${graphCase}&from=${ent["P2"]}&to=${ent["P3"]}&maxHops=2&asOf=${at20}`)).json();
      expect(two.found).toBe(true);
      expect(two.hops).toBe(2);
      expect(two.nodes.map((n: { id: string }) => n.id)).toEqual([ent["P2"], ent["P1a"], ent["P3"]]);

      const one = (await get(`/v2/graph/path?caseId=${graphCase}&from=${ent["P2"]}&to=${ent["P3"]}&maxHops=1&asOf=${at20}`)).json();
      expect(one.found).toBe(false);

      // Now, the co-location has ended: no path holds.
      const now = (await get(`/v2/graph/path?caseId=${graphCase}&from=${ent["P2"]}&to=${ent["P3"]}&maxHops=3`)).json();
      expect(now.found).toBe(false);
    });

    it("tells an entity's timeline in order, with edges starting and ending", async () => {
      const r = (await get(`/v2/graph/timeline?caseId=${graphCase}&entityId=${ent["P1a"]}`)).json();
      const kinds = r.events.map((e: { kind: string }) => e.kind);
      expect(kinds.filter((k: string) => k === "observation")).toHaveLength(2);
      expect(kinds).toContain("edge-start");
      expect(kinds).toContain("edge-end");
      const times = r.events.map((e: { at: string }) => new Date(e.at).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    it("answers a co-location window", async () => {
      const hit = (await get(`/v2/graph/colocation?caseId=${graphCase}&entityId=${ent["P1a"]}&from=${T0.toISOString()}&to=${at(60).toISOString()}`)).json();
      expect(hit.edges).toHaveLength(1);
      expect(hit.others.map((n: { id: string }) => n.id)).toEqual([ent["P3"]]);
      const miss = (await get(`/v2/graph/colocation?caseId=${graphCase}&entityId=${ent["P1a"]}&from=${at(120).toISOString()}&to=${at(180).toISOString()}`)).json();
      expect(miss.edges).toHaveLength(0);
    });

    it("lists edges as of a moment and logs the read", async () => {
      expect((await get(`/v2/graph/edges?caseId=${graphCase}`)).json().count).toBe(1);
      const r = (await get(`/v2/graph/edges?caseId=${graphCase}&asOf=${at(20).toISOString()}`)).json();
      expect(r.count).toBe(2);
      // A confidence is never returned without the rule that produced it.
      expect(r.edges.every((e: { basis: string | null }) => typeof e.basis === "string" && e.basis.length > 0)).toBe(true);
      const log = await prisma.accessLog.findFirst({ where: { authorizationId: graphAuth, targetType: "EntityEdge" }, orderBy: { createdAt: "desc" } });
      expect(log?.targetIds.sort()).toEqual(r.edges.map((e: { id: string }) => e.id).sort());
    });

    it("refuses the graph to an authorization without READ_GRAPH", async () => {
      const id = await newCase("no-read");
      await authorize(id, { actionClasses: ["COLLECT"] });
      const r = await get(`/v2/graph/edges?caseId=${id}`);
      expect(r.statusCode).toBe(403);
      expect(r.json().reason).toBe("action-not-permitted");
    });

    it("answers a question about an entity's links with citations that exist, and logs the question", async () => {
      const r = await post("/v2/ask", { caseId: graphCase, question: "Who is connected to Bob Smith?" });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(body.plannedBy).toBe("rules");
      expect(body.shape).toBe("neighbors-of");
      expect(body.answer.status).toBe("answered");
      expect(body.answer.claims.length).toBeGreaterThan(0);
      expect(body.answer.text).toMatch(/same device/);
      for (const c of body.answer.claims) expect(c.observationIds.length).toBeGreaterThan(0);
      // Every citation is a real observation under this authorization.
      const cited = await prisma.observation.findMany({ where: { id: { in: body.answer.citations }, authorizationId: graphAuth }, select: { id: true } });
      expect(cited.map((c) => c.id).sort()).toEqual([...body.answer.citations].sort());
      const log = await prisma.accessLog.findFirst({ where: { authorizationId: graphAuth, targetType: "Reason" }, orderBy: { createdAt: "desc" } });
      expect(log?.queryText).toBe("Who is connected to Bob Smith?");
      expect([...(log?.targetIds ?? [])].sort()).toEqual([...body.answer.citations].sort());
    });

    it("refuses a subject it does not know, saying what would be needed", async () => {
      const reference = (await get(`/cases/${graphCase}/authorization`)).json().authorization.reference;
      const body = (await post("/v2/ask", { caseId: graphCase, question: "What do we know about Zed Nobody?" })).json();
      expect(body.answer.status).toBe("refused");
      expect(body.answer.refusal.reason).toBe("unknown-entity");
      expect(body.answer.refusal.requires).toContain('Collection on "Zed Nobody"');
      expect(body.answer.refusal.message).toContain(`#${reference}`);
      expect(body.answer.citations).toEqual([]);
    });

    it("refuses a question it cannot plan and names the shapes it can", async () => {
      const body = (await post("/v2/ask", { caseId: graphCase, question: "Is it raining in Portland today?" })).json();
      expect(body.answer.status).toBe("refused");
      expect(body.answer.refusal.reason).toBe("cannot-plan");
      expect(body.answer.refusal.message).toContain("REASON_PROVIDER=none");
      expect(body.plan).toBeNull();
    });

    it("says insufficient evidence instead of composing an answer", async () => {
      const body = (await post("/v2/ask", { caseId: graphCase, question: `Who was near Dan Roe between ${T0.toISOString()} and ${at(60).toISOString()}?` })).json();
      expect(body.shape).toBe("co-location-window");
      expect(body.answer.status).toBe("insufficient-evidence");
      expect(body.answer.claims).toEqual([]);
      expect(body.answer.text).toContain('"Dan Roe"');
    });

    it("answers which sources were consulted from the collection log", async () => {
      const body = (await post("/v2/ask", { caseId: graphCase, question: "Which sources were consulted?" })).json();
      expect(body.answer.status).toBe("answered");
      expect(body.answer.claims[0].basis).toBe("collection-log");
      expect(body.answer.claims[0].sourceIds).toContain("adsb-live");
      expect(body.answer.claims[0].text).toMatch(/sec-edgar.*returned nothing|returned nothing/);
    });

    it("refuses a question to an authorization without READ_GRAPH", async () => {
      const id = await newCase("no-read-ask");
      await authorize(id, { actionClasses: ["COLLECT"] });
      const r = await post("/v2/ask", { caseId: id, question: "Who is connected to Bob Smith?" });
      expect(r.statusCode).toBe(403);
      expect(r.json().reason).toBe("action-not-permitted");
    });

    it("reports the graph consistent for this authorization", async () => {
      const r = await post("/v2/graph/consistency", { caseId: graphCase });
      expect(r.statusCode).toBe(200);
      expect(r.json().clean).toBe(true);
      const event = await prisma.auditEvent.findFirst({ where: { caseId: graphCase, action: "v2.graph.checked" } });
      expect((event?.detail as { clean: boolean }).clean).toBe(true);
    });
  });
});

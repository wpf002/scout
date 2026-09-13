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
      expect(ids).toEqual(["adsb-live", "sec-edgar"]);
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
      const log = await prisma.accessLog.findFirst({ where: { authorizationId, targetType: "MatchDecision" }, orderBy: { createdAt: "desc" } });
      expect(log?.targetIds).toEqual([pair.decisionId]);
    });

    it("lets a pin outrank the model, supersedes memberships, and keeps the history", async () => {
      const pin = await post("/v2/adjudicate", {
        caseId, leftObservationId: ids["A2"], rightObservationId: ids["A1"], decision: "NON_MATCH", note: "different airframes, hex reused",
      });
      expect(pin.statusCode).toBe(201);
      expect(pin.json().pairKey).toBe([ids["A1"], ids["A2"]].sort().join("|"));

      const r = await post("/v2/resolve", { caseId, entityKind: "AIRCRAFT" });
      const body = r.json();
      expect(body.counts.pinned).toBe(1);
      const forA1 = body.entities.find((e: { members: string[] }) => e.members.includes(ids["A1"] as string));
      const forA2 = body.entities.find((e: { members: string[] }) => e.members.includes(ids["A2"] as string));
      expect(forA1.id).not.toBe(forA2.id);
      expect(forA1.status).toBe("PROVISIONAL");

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
      expect(body.sources.map((s: { sourceId: string }) => s.sourceId).sort()).toEqual(["adsb-live", "sec-edgar"]);
      const log = await prisma.accessLog.findFirst({ where: { authorizationId, targetType: "Entity" }, orderBy: { createdAt: "desc" } });
      expect(log?.resultCount).toBe(body.count);
    });

    it("refuses an adjudication about an observation outside the authorization", async () => {
      const r = await post("/v2/adjudicate", { caseId, leftObservationId: ids["A1"], rightObservationId: "obs_not_ours", decision: "MATCH", note: "x" });
      expect(r.statusCode).toBe(404);
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@scout/db";
import { ProhibitionError, refuseInterception, refuseUnauthorizedAccess } from "@scout/scope";

import { validateV2Startup } from "./v2/prohibitions.js";

/**
 * The five hard prohibitions, attempted through the API (Phase 11).
 *
 * Each attempt must be refused and must leave an audit event. Two of the
 * five are configuration and are refused before the process serves; two
 * have no route at all, which the tests assert structurally and then prove
 * the guard would refuse if one were added; the fifth is attempted through
 * the routes that exist.
 */

const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

let app: FastifyInstance;
const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });
const REF = `PROHIB-${Date.now()}`;
const day = 86_400_000;

run("Phase 11: the five prohibitions, attempted", () => {
  let caseId: string;
  let openCase: string;
  let gallery: string;

  beforeAll(async () => {
    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();
    const c = await post("/cases", { name: "prohibitions", authorizationRef: REF, scope: [] });
    caseId = c.json().id;
    await post(`/cases/${caseId}/authorization`, { issuedBy: "vitest", sourceClasses: ["FIRST_PARTY"], actionClasses: ["COLLECT", "READ_GRAPH", "RESOLVE", "BIOMETRIC_COMPARE"], entityKinds: ["DEVICE", "PERSON"], validUntil: new Date(Date.now() + 30 * day).toISOString(), confirmAuthorized: true });
    const o = await post("/cases", { name: "prohibitions-no-compare", authorizationRef: `${REF}-2`, scope: [] });
    openCase = o.json().id;
    await post(`/cases/${openCase}/authorization`, { issuedBy: "vitest", sourceClasses: ["FIRST_PARTY"], actionClasses: ["COLLECT", "READ_GRAPH"], validUntil: new Date(Date.now() + 30 * day).toISOString(), confirmAuthorized: true });
    gallery = (await post("/v2/galleries", { name: "prohibitions", purpose: "prohibition attempts fixture", custodianOrg: "vitest", lawfulBasis: "CONSENT", lawfulBasisDocumentRef: "P-1", reviewDueAt: new Date(Date.now() + 30 * day).toISOString(), confirmLawfulBasis: true })).json().id;
    process.env["RECOGNITION_ENABLED"] = "true";
    process.env["RECOGNITION_TEMPLATE_KEY"] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  });

  afterAll(async () => {
    delete process.env["RECOGNITION_ENABLED"];
    await app?.close();
    await prisma.$disconnect();
  });

  it("1. unauthorized access: no route reaches a device, account, network or endpoint, and the guard refuses", () => {
    const routes = app.printRoutes({ commonPrefix: false }).toLowerCase();
    for (const word of ["credential", "password", "login", "session", "exploit", "camera", "microphone", "shell", "ssh"]) expect(routes).not.toContain(word);
    // The only device data path is first-party ingest under a consent record; the guard behind it refuses anything else.
    expect(() => refuseUnauthorizedAccess({ kind: "camera", enrolled: false, consentRef: null })).toThrow(ProhibitionError);
    expect(() => refuseUnauthorizedAccess({ kind: "device", enrolled: true, consentRef: "" })).toThrow(/not enrolled with a consent record/);
    expect(() => refuseUnauthorizedAccess({ kind: "device", enrolled: true, consentRef: "CONSENT-1" })).not.toThrow();
  });

  it("1b. a device batch without a consent record is refused at the door, and nothing is written", async () => {
    const r = await post("/v2/collect", { caseId, collectorId: "first-party-telemetry", params: { deviceId: "cam-1", points: [{ at: "2026-09-13T10:00:00Z", lon: 5, lat: 60 }] } });
    expect(r.statusCode).toBe(400);
    expect(await prisma.observation.count({ where: { caseId } })).toBe(0);
  });

  it("2. interception: no capture or intercept route exists, and the guard refuses capture unconditionally", () => {
    const routes = app.printRoutes({ commonPrefix: false }).toLowerCase();
    for (const word of ["intercept", "capture", "pcap", "sniff", "ss7", "wiretap"]) expect(routes).not.toContain(word);
    expect(() => refuseInterception({ kind: "packet-capture", scoutIsParty: true, explicitAuthorizationRef: "ANY" })).toThrow(/interception/);
    expect(() => refuseInterception({ kind: "telecom-intercept", scoutIsParty: true, explicitAuthorizationRef: "ANY" })).toThrow(ProhibitionError);
    expect(() => refuseInterception({ kind: "message-read", scoutIsParty: false, explicitAuthorizationRef: null })).toThrow(/not a party/);
    expect(() => refuseInterception({ kind: "message-read", scoutIsParty: true, explicitAuthorizationRef: null })).not.toThrow();
  });

  it("3. open-world biometrics: every attempt through the API is refused and audited", async () => {
    const before = await prisma.auditEvent.count({ where: { action: "v2.prohibition.refused" } });
    // Without a gallery id there is no route to reach: the schema refuses.
    expect((await post("/v2/compare", { caseId, modality: "FACE", mediaB64: "AAAA" })).statusCode).toBe(400);
    // A gallery that does not exist has no lawful basis on record.
    const ghost = await post("/v2/compare", { caseId, galleryId: "gal_nope", modality: "FACE", mediaB64: "AAAA" });
    expect(ghost.statusCode).toBe(403);
    expect(ghost.json().prohibition).toBe("OPEN_WORLD_BIOMETRICS");
    // An authorization without BIOMETRIC_COMPARE.
    const noAction = await post("/v2/compare", { caseId: openCase, galleryId: gallery, modality: "FACE", mediaB64: "AAAA" });
    expect(noAction.statusCode).toBe(403);
    expect(noAction.json().prohibition).toBe("OPEN_WORLD_BIOMETRICS");
    // Building a template from scraped media.
    const scraped = await post(`/v2/galleries/${gallery}/enroll`, { caseId, entityId: "ent_x", modality: "FACE", mediaB64: "AAAA", origin: "public-scrape", lawfulBasisDocumentRef: "D", expiresAt: new Date(Date.now() + day).toISOString() });
    expect(scraped.statusCode).toBe(403);
    expect(scraped.json().message).toMatch(/scraped/);
    const events = await prisma.auditEvent.findMany({ where: { action: "v2.prohibition.refused" }, orderBy: { createdAt: "asc" } });
    expect(events.length - before).toBe(3);
    const recent = events.slice(-3);
    expect(recent.every((e) => (e.detail as { prohibition: string }).prohibition === "OPEN_WORLD_BIOMETRICS")).toBe(true);
    expect(recent.map((e) => (e.detail as { route: string }).route)).toEqual(["/v2/compare", "/v2/compare", "/v2/galleries/:galleryId/enroll"]);
    expect(recent[1]?.caseId).toBe(openCase);
    expect(recent.every((e) => e.actor.length > 0)).toBe(true);
  });

  it("4. autonomous consequential action: a process configured for it does not start, and the refusal is on the record", async () => {
    const before = await prisma.auditEvent.count({ where: { action: "v2.startup.refused" } });
    const saved = process.env["AGENT_MAX_AUTONOMOUS_TIER"];
    process.env["AGENT_MAX_AUTONOMOUS_TIER"] = "consequential";
    try {
      const { buildServer } = await import("./server.js");
      await expect(buildServer()).rejects.toThrow(/AGENT_MAX_AUTONOMOUS_TIER=consequential is not permitted/);
    } finally {
      if (saved === undefined) delete process.env["AGENT_MAX_AUTONOMOUS_TIER"];
      else process.env["AGENT_MAX_AUTONOMOUS_TIER"] = saved;
    }
    const events = await prisma.auditEvent.findMany({ where: { action: "v2.startup.refused" }, orderBy: { createdAt: "desc" }, take: 1 });
    expect(await prisma.auditEvent.count({ where: { action: "v2.startup.refused" } })).toBe(before + 1);
    expect((events[0]?.detail as { prohibition: string }).prohibition).toBe("AUTONOMOUS_CONSEQUENTIAL_ACTION");
    expect(() => validateV2Startup({ AGENT_MAX_AUTONOMOUS_TIER: "prepare" })).not.toThrow();
    expect(validateV2Startup({}).agentTier).toBe("observe");
  });

  it("5. forced resolution: a collapsed review band does not start, per kind too, and the refusal is on the record", async () => {
    const before = await prisma.auditEvent.count({ where: { action: "v2.startup.refused" } });
    const saved = { m: process.env["RESOLUTION_MATCH_THRESHOLD"], r: process.env["RESOLUTION_REVIEW_THRESHOLD"] };
    process.env["RESOLUTION_MATCH_THRESHOLD"] = "7000";
    process.env["RESOLUTION_REVIEW_THRESHOLD"] = "7000";
    try {
      const { buildServer } = await import("./server.js");
      await expect(buildServer()).rejects.toThrow(/must exceed review threshold/);
    } finally {
      if (saved.m === undefined) delete process.env["RESOLUTION_MATCH_THRESHOLD"]; else process.env["RESOLUTION_MATCH_THRESHOLD"] = saved.m;
      if (saved.r === undefined) delete process.env["RESOLUTION_REVIEW_THRESHOLD"]; else process.env["RESOLUTION_REVIEW_THRESHOLD"] = saved.r;
    }
    expect(await prisma.auditEvent.count({ where: { action: "v2.startup.refused" } })).toBe(before + 1);
    expect(() => validateV2Startup({ RESOLUTION_MATCH_THRESHOLD_PERSON: "6000", RESOLUTION_REVIEW_THRESHOLD_PERSON: "6500" })).toThrow(/kind PERSON/);
    expect(() => validateV2Startup({ RESOLUTION_MATCH_THRESHOLD: "9500", RESOLUTION_REVIEW_THRESHOLD: "7000", RESOLUTION_MATCH_THRESHOLD_VESSEL: "9000" })).not.toThrow();
    expect(() => validateV2Startup({ RESOLUTION_MATCH_THRESHOLD: "10001" })).toThrow(/basis points/);
  });

  it("5b. the graph keeps UNRESOLVED and INDETERMINATE: a resolution run never merges to avoid an empty answer", async () => {
    // A pair with no basis to compare is INDETERMINATE and stays its own entity: proven in the stage 3 suite
    // through the stand-in resolver (disputed components, review band). Here: the outcomes exist in the schema.
    const outcomes = await prisma.$queryRaw<Array<{ value: string }>>`SELECT unnest(enum_range(NULL::"MatchOutcome"))::text AS value`;
    expect(outcomes.map((o) => o.value).sort()).toEqual(["INDETERMINATE", "MATCH", "NON_MATCH", "REVIEW"]);
    const statuses = await prisma.$queryRaw<Array<{ value: string }>>`SELECT unnest(enum_range(NULL::"EntityStatus"))::text AS value`;
    expect(statuses.map((o) => o.value)).toEqual(expect.arrayContaining(["UNRESOLVED", "DISPUTED", "PROVISIONAL", "RESOLVED"]));
  });
});

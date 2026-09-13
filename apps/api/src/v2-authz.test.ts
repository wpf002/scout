import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@scout/db";

/**
 * The authorization matrix (Phase 11).
 *
 * Every v2 endpoint that acts under a case's authorization is called against
 * four cases: one with no authorization, one whose window has not opened,
 * one whose window has closed, one that was revoked. Each call must be
 * refused with the reason that names the state, before anything is fetched,
 * resolved, read or compared. Then the subject-taking endpoints are called
 * with a subject the boundary does not cover.
 */

const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

let app: FastifyInstance;
const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });
const get = (url: string) => app.inject({ method: "GET", url });
const REF = `AUTHZ-${Date.now()}`;
const day = 86_400_000;

async function newCase(name: string, scope: Array<{ kind: string; value: string }> = []) {
  const r = await post("/cases", { name, authorizationRef: `${REF}-${name}`, scope });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

async function authorize(id: string, overrides: Record<string, unknown> = {}) {
  const r = await post(`/cases/${id}/authorization`, {
    issuedBy: "engagement letter, vitest",
    sourceClasses: ["SENSOR", "PUBLIC_RECORD", "OPEN_WEB", "SATELLITE", "FIRST_PARTY"],
    actionClasses: ["COLLECT", "READ_GRAPH", "RESOLVE", "BIOMETRIC_COMPARE"],
    validUntil: new Date(Date.now() + 365 * day).toISOString(),
    confirmAuthorized: true,
    ...overrides,
  });
  expect(r.statusCode).toBe(201);
  return r.json();
}

interface Endpoint {
  name: string;
  call: (caseId: string) => Promise<{ statusCode: number; json: () => { reason?: string; error?: string; code?: string } }>;
}

run("Phase 11: the authorization matrix", () => {
  let gallery: string;
  const states: Array<{ state: string; reason: string; caseId: string }> = [];

  beforeAll(async () => {
    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();

    const none = await newCase("none");
    const notStarted = await newCase("not-started");
    await authorize(notStarted, { validFrom: new Date(Date.now() + 2 * day).toISOString(), validUntil: new Date(Date.now() + 30 * day).toISOString() });
    const expired = await newCase("expired");
    await authorize(expired, { validFrom: new Date(Date.now() - 3 * day).toISOString(), validUntil: new Date(Date.now() - day).toISOString() });
    const revoked = await newCase("revoked");
    await authorize(revoked);
    expect((await post(`/cases/${revoked}/authorization/revoke`, { reason: "matrix" })).statusCode).toBe(200);
    states.push(
      { state: "no authorization", reason: "authorization-missing", caseId: none },
      { state: "not yet started", reason: "authorization-not-started", caseId: notStarted },
      { state: "expired", reason: "authorization-expired", caseId: expired },
      { state: "revoked", reason: "authorization-revoked", caseId: revoked },
    );
    const created = await post("/v2/galleries", { name: "matrix", purpose: "authorization matrix fixture", custodianOrg: "vitest", lawfulBasis: "CONSENT", lawfulBasisDocumentRef: "M-1", reviewDueAt: new Date(Date.now() + 30 * day).toISOString(), confirmLawfulBasis: true });
    gallery = created.json().id;
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  const ENDPOINTS: Endpoint[] = [
    { name: "POST /v2/collect", call: (c) => post("/v2/collect", { caseId: c, collectorId: "adsb-live" }) },
    { name: "GET /v2/observations", call: (c) => get(`/v2/observations?caseId=${c}`) },
    { name: "POST /v2/resolve", call: (c) => post("/v2/resolve", { caseId: c, entityKind: "PERSON" }) },
    { name: "GET /v2/entities", call: (c) => get(`/v2/entities?caseId=${c}`) },
    { name: "GET /v2/review", call: (c) => get(`/v2/review?caseId=${c}`) },
    { name: "POST /v2/adjudicate", call: (c) => post("/v2/adjudicate", { caseId: c, leftObservationId: "obs_a", rightObservationId: "obs_b", decision: "MATCH", note: "matrix" }) },
    { name: "POST /v2/ask", call: (c) => post("/v2/ask", { caseId: c, question: "Which sources were consulted?" }) },
    { name: "POST /v2/links/derive", call: (c) => post("/v2/links/derive", { caseId: c }) },
    { name: "GET /v2/graph/edges", call: (c) => get(`/v2/graph/edges?caseId=${c}`) },
    { name: "GET /v2/graph/neighbors", call: (c) => get(`/v2/graph/neighbors?caseId=${c}&entityId=x`) },
    { name: "GET /v2/graph/path", call: (c) => get(`/v2/graph/path?caseId=${c}&from=x&to=y`) },
    { name: "GET /v2/graph/timeline", call: (c) => get(`/v2/graph/timeline?caseId=${c}&entityId=x`) },
    { name: "GET /v2/graph/colocation", call: (c) => get(`/v2/graph/colocation?caseId=${c}&entityId=x&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`) },
    { name: "POST /v2/graph/consistency", call: (c) => post("/v2/graph/consistency", { caseId: c }) },
    { name: "GET /v2/imagery/tiles", call: (c) => get(`/v2/imagery/tiles?caseId=${c}`) },
    { name: "GET /v2/imagery/preview/:id", call: (c) => get(`/v2/imagery/preview/tile_x?caseId=${c}`) },
    { name: "GET /v2/galleries/:id?caseId", call: (c) => get(`/v2/galleries/${gallery}?caseId=${c}`) },
    { name: "POST /v2/galleries/:id/enroll", call: (c) => post(`/v2/galleries/${gallery}/enroll`, { caseId: c, entityId: "x", modality: "FACE", mediaB64: "AAAA", origin: "consented-upload", lawfulBasisDocumentRef: "D", expiresAt: new Date(Date.now() + day).toISOString() }) },
    { name: "POST /v2/compare", call: (c) => post("/v2/compare", { caseId: c, galleryId: gallery, modality: "FACE", mediaB64: "AAAA" }) },
  ];

  it("covers every v2 route that takes a case", async () => {
    const routed = app.printRoutes({ commonPrefix: false });
    const caseRoutes = ["/v2/collect", "/v2/observations", "/v2/resolve", "/v2/entities", "/v2/review", "/v2/adjudicate", "/v2/ask", "/v2/links/derive", "/v2/graph/edges", "/v2/graph/neighbors", "/v2/graph/path", "/v2/graph/timeline", "/v2/graph/colocation", "/v2/graph/consistency", "/v2/imagery/tiles", "/v2/imagery/preview", "/v2/galleries/", "/v2/compare"];
    for (const route of caseRoutes) expect(routed).toContain(route.replace(/^\//, "").split("/").pop() as string);
    expect(ENDPOINTS.length).toBeGreaterThanOrEqual(caseRoutes.length);
  });

  for (const s of ["no authorization", "not yet started", "expired", "revoked"]) {
    it(`refuses every endpoint when the authorization is ${s}, naming the state`, async () => {
      const state = states.find((x) => x.state === s) as (typeof states)[number];
      const failures: string[] = [];
      for (const endpoint of ENDPOINTS) {
        const r = await endpoint.call(state.caseId);
        const body = r.json();
        if (r.statusCode !== 403 || body.reason !== state.reason) failures.push(`${endpoint.name} → ${r.statusCode} ${body.reason ?? body.error ?? body.code ?? ""}`);
      }
      expect(failures).toEqual([]);
    });
  }

  it("refuses a subject the boundary does not cover, before fetching", async () => {
    const covered = await newCase("covered", [{ kind: "identifier", value: "Apple Inc." }, { kind: "domain", value: "example.org" }]);
    await authorize(covered);
    process.env["SEC_EDGAR_USER_AGENT"] = "Scout tests test@example.invalid";
    const edgar = await post("/v2/collect", { caseId: covered, collectorId: "sec-edgar", subject: { kind: "company", value: "Microsoft Corp" } });
    expect(edgar.statusCode).toBe(403);
    expect(edgar.json().reason).toBe("out-of-scope");
    const web = await post("/v2/collect", { caseId: covered, collectorId: "open-web", subject: { kind: "domain", value: "elsewhere.example" } });
    expect(web.statusCode).toBe(403);
    expect(web.json().reason).toBe("out-of-scope");
    // No audit event says a run happened for the refused subject.
    const ran = await prisma.auditEvent.findMany({ where: { caseId: covered, action: "v2.collection.ran" } });
    expect(ran).toEqual([]);
    // A question about a subject the graph does not hold is refused with what would be needed, not answered.
    const asked = (await post("/v2/ask", { caseId: covered, question: "What do we know about Zed Nobody?" })).json();
    expect(asked.answer.status).toBe("refused");
    expect(asked.answer.refusal.reason).toBe("unknown-entity");
  });

  it("refuses each action class independently of the window", async () => {
    const readOnly = await newCase("read-only");
    await authorize(readOnly, { actionClasses: ["READ_GRAPH"] });
    expect((await post("/v2/collect", { caseId: readOnly, collectorId: "adsb-live" })).json().reason).toBe("action-not-permitted");
    expect((await post("/v2/resolve", { caseId: readOnly, entityKind: "PERSON" })).json().reason).toBe("action-not-permitted");
    expect((await post("/v2/adjudicate", { caseId: readOnly, leftObservationId: "obs_a", rightObservationId: "obs_b", decision: "MATCH", note: "x" })).json().reason).toBe("action-not-permitted");
    expect((await get(`/v2/entities?caseId=${readOnly}`)).statusCode).toBe(200);
    const collectOnly = await newCase("collect-only");
    await authorize(collectOnly, { actionClasses: ["COLLECT"] });
    for (const url of [`/v2/entities?caseId=${collectOnly}`, `/v2/graph/edges?caseId=${collectOnly}`, `/v2/imagery/tiles?caseId=${collectOnly}`]) {
      const r = await get(url);
      expect(r.statusCode).toBe(403);
      expect(r.json().reason).toBe("action-not-permitted");
    }
    expect((await post("/v2/ask", { caseId: collectOnly, question: "Which sources were consulted?" })).json().reason).toBe("action-not-permitted");
  });
});

/**
 * Phase 1 exit-gate tests.
 *
 * These run against a real Postgres — the guarantees being checked (audit rows
 * written, scope loaded from the case, immutability) live in the database, so
 * mocking it would test nothing. Set DATABASE_URL to a disposable database;
 * the suite is skipped without one.
 *
 * Note there is no cleanup step. Audit rows cannot be deleted, by design, so
 * every run leaves its trail behind. Use a throwaway database.
 *
 * HIBP_API_KEY is deliberately unset here: an in-scope call then lands on
 * `inert` instead of hitting the network, which lets the scope gate be tested
 * end-to-end without ever making a real request about a real person.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@scout/db";

const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

let app: FastifyInstance;
let caseId: string;
const AUTH_REF = `TEST-ENG-${Date.now()}`;

async function post(url: string, payload: unknown) {
  return app.inject({ method: "POST", url, payload: payload as object });
}

run("Scout API — Phase 1", () => {
  beforeAll(async () => {
    delete process.env["HIBP_API_KEY"];
    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  // ── cases ────────────────────────────────────────────────────────────────
  describe("case creation", () => {
    it("creates a case with scope and an authorization reference", async () => {
      const response = await post("/cases", {
        name: "Phase 1 exit gate",
        authorizationRef: AUTH_REF,
        scope: [
          { kind: "domain", value: "example.com", note: "authorized domain" },
          { kind: "identifier", value: "alice@example.org" },
        ],
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.authorizationRef).toBe(AUTH_REF);
      expect(body.scopeEntries).toHaveLength(2);
      caseId = body.id;
    });

    it("refuses a case with no authorization reference", async () => {
      const response = await post("/cases", { name: "unauthorized" });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("invalid-request");
    });

    it("refuses a case whose authorization reference is blank", async () => {
      const response = await post("/cases", {
        name: "blank ref",
        authorizationRef: "   ",
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ── the planner ──────────────────────────────────────────────────────────
  describe("POST /query plans and never executes", () => {
    it("blocks scoped sources outright when there is no case", async () => {
      const response = await post("/query", {
        subject: { kind: "email", value: "bob@example.com" },
      });
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.executed).toBe(false);

      const scoped = body.plan.filter(
        (entry: { requiresScope: boolean }) => entry.requiresScope,
      );
      expect(scoped.length).toBeGreaterThan(0);
      for (const entry of scoped) {
        expect(entry.status).toBe("blocked");
        expect(entry.reason).toBe("case-required");
      }
    });

    it("reads scope from the case, not the environment", async () => {
      const inScope = await post("/query", {
        caseId,
        subject: { kind: "email", value: "bob@example.com" },
      });
      const hibp = inScope
        .json()
        .plan.find((e: { sourceId: string }) => e.sourceId === "hibp");
      // In scope via the domain entry; inert only because no key is set.
      expect(hibp.status).toBe("inert");
      expect(hibp.matchedScope.value).toBe("example.com");

      const outOfScope = await post("/query", {
        caseId,
        subject: { kind: "email", value: "victim@unrelated.net" },
      });
      const blocked = outOfScope
        .json()
        .plan.find((e: { sourceId: string }) => e.sourceId === "hibp");
      expect(blocked.status).toBe("blocked");
      expect(blocked.reason).toBe("out-of-scope");
    });

    it("returns deeplinks as URLs for the client to open, never fetching them", async () => {
      const response = await post("/query", {
        caseId,
        subject: { kind: "domain", value: "example.com" },
      });
      const crtsh = response
        .json()
        .plan.find((e: { sourceId: string }) => e.sourceId === "crtsh");
      expect(crtsh.status).toBe("deeplink");
      expect(crtsh.url).toBe("https://crt.sh/?q=example.com");
      // A deeplink entry never carries an execution descriptor — there is
      // nothing for Scout to run.
      expect(crtsh.execution).toBeUndefined();
    });

    it("writes a PLAN audit row for every scoped source it considered", async () => {
      const before = await prisma.queryLog.count({
        where: { caseId, phase: "PLAN" },
      });
      await post("/query", {
        caseId,
        subject: { kind: "email", value: "bob@example.com" },
      });
      const after = await prisma.queryLog.count({
        where: { caseId, phase: "PLAN" },
      });
      expect(after).toBeGreaterThan(before);
    });
  });

  // ── the scope gate under execution ───────────────────────────────────────
  describe("scoped execution", () => {
    it("refuses to run without a case", async () => {
      const response = await post("/exposure/hibp", {
        confirm: true,
        subject: { kind: "email", value: "bob@example.com" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("refuses to run without an explicit confirmation", async () => {
      const response = await post("/exposure/hibp", {
        caseId,
        subject: { kind: "email", value: "bob@example.com" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("returns 403 with a stable reason for an out-of-scope subject", async () => {
      const response = await post("/exposure/hibp", {
        caseId,
        confirm: true,
        subject: { kind: "email", value: "victim@unrelated.net" },
      });
      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error).toBe("scope-denied");
      expect(body.reason).toBe("out-of-scope");
      expect(body.sourceId).toBe("hibp");
    });

    it("writes a DENIED audit row for the refused attempt", async () => {
      const denial = await prisma.queryLog.findFirst({
        where: {
          caseId,
          sourceId: "hibp",
          phase: "EXECUTE",
          outcome: "DENIED",
          subjectValue: "victim@unrelated.net",
        },
        orderBy: { createdAt: "desc" },
      });

      expect(denial).not.toBeNull();
      expect(denial?.reason).toBe("out-of-scope");
      // The auth ref is snapshotted, not joined — later case edits cannot
      // rewrite what the record says about this attempt.
      expect(denial?.authorizationRef).toBe(AUTH_REF);
      expect(denial?.requiresScope).toBe(true);
    });

    it("reports inert rather than inventing a result when the key is absent", async () => {
      const response = await post("/exposure/hibp", {
        caseId,
        confirm: true,
        subject: { kind: "email", value: "bob@example.com" },
      });
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.status).toBe("inert");
      expect(body.reason).toBe("missing-key");
      expect(body.data).toBeUndefined();
      // Even a no-op carries provenance.
      expect(body.provenance.sourceId).toBe("hibp");
      expect(body.provenance.queryTerm).toBe("bob@example.com");

      const log = await prisma.queryLog.findFirst({
        where: { caseId, outcome: "INERT", subjectValue: "bob@example.com" },
        orderBy: { createdAt: "desc" },
      });
      expect(log).not.toBeNull();
      expect(log?.matchedScopeValue).toBe("example.com");
    });
  });

  // ── red team ─────────────────────────────────────────────────────────────
  describe("red team: scope cannot be widened by a request", () => {
    it("ignores scope-shaped fields smuggled into the request body", async () => {
      const response = await post("/exposure/hibp", {
        caseId,
        confirm: true,
        subject: { kind: "email", value: "victim@unrelated.net" },
        // None of these are real parameters. If any of them were honoured,
        // the request would succeed instead of 403.
        scope: [{ kind: "domain", value: "unrelated.net" }],
        scopeEntries: [{ kind: "domain", value: "unrelated.net" }],
        authorizationRef: "FORGED",
        requiresScope: false,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().reason).toBe("out-of-scope");
    });

    it("does not treat a lookalike domain as in scope", async () => {
      for (const value of [
        "bob@notexample.com",
        "bob@example.com.evil.net",
        "bob@example.co",
      ]) {
        const response = await post("/exposure/hibp", {
          caseId,
          confirm: true,
          subject: { kind: "email", value },
        });
        expect(response.statusCode, `${value} must be refused`).toBe(403);
      }
    });

    it("cannot reach a scoped source through a case that does not exist", async () => {
      const response = await post("/exposure/hibp", {
        caseId: "case_does_not_exist",
        confirm: true,
        subject: { kind: "email", value: "bob@example.com" },
      });
      expect(response.statusCode).toBe(404);
    });

    it("leaves every scoped source blocked when the case has no scope", async () => {
      const created = await post("/cases", {
        name: "empty scope",
        authorizationRef: `${AUTH_REF}-EMPTY`,
      });
      const emptyCaseId = created.json().id;

      const response = await post("/exposure/hibp", {
        caseId: emptyCaseId,
        confirm: true,
        subject: { kind: "email", value: "bob@example.com" },
      });
      // Empty scope is OFF, not open.
      expect(response.statusCode).toBe(403);
      expect(response.json().reason).toBe("scope-empty");
    });
  });

  // ── scope editing is an audited act ──────────────────────────────────────
  describe("scope editing", () => {
    it("refuses to add scope without an explicit authorization claim", async () => {
      const response = await post(`/cases/${caseId}/scope`, {
        kind: "domain",
        value: "newly-authorized.example",
      });
      expect(response.statusCode).toBe(400);
    });

    it("adds scope and records the claim in the audit log", async () => {
      const response = await post(`/cases/${caseId}/scope`, {
        kind: "domain",
        value: "newly-authorized.example",
        confirmAuthorized: true,
      });
      expect(response.statusCode).toBe(201);

      const event = await prisma.auditEvent.findFirst({
        where: { caseId, action: "scope.added" },
        orderBy: { createdAt: "desc" },
      });
      expect(event).not.toBeNull();
      expect(event?.detail).toMatchObject({
        value: "newly-authorized.example",
        confirmedAuthorized: true,
      });
    });

    it("takes effect immediately for the gate", async () => {
      const response = await post("/exposure/hibp", {
        caseId,
        confirm: true,
        subject: { kind: "email", value: "x@newly-authorized.example" },
      });
      // Now in scope, so it gets as far as the key check.
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("inert");
    });
  });

  // ── findings carry provenance ────────────────────────────────────────────
  describe("findings", () => {
    it("rejects a finding that names a source outside the registry", async () => {
      const response = await post(`/cases/${caseId}/findings`, {
        sourceId: "totally-made-up",
        title: "fabricated",
        queryTerm: "example.com",
        queryKind: "domain",
      });
      expect(response.statusCode).toBe(400);
    });

    it("stores provenance alongside the finding", async () => {
      const response = await post(`/cases/${caseId}/findings`, {
        sourceId: "crtsh",
        title: "Subdomain observed in CT logs",
        summary: "admin.example.com",
        queryTerm: "example.com",
        queryKind: "domain",
        data: { host: "admin.example.com" },
      });
      expect(response.statusCode).toBe(201);

      const finding = response.json();
      expect(finding.sourceId).toBe("crtsh");
      // Tier comes from the registry, not the request body.
      expect(finding.tier).toBe("INFRA");
      expect(finding.queryTerm).toBe("example.com");
      expect(finding.caseId).toBe(caseId);
      expect(finding.observedAt).toBeTruthy();
    });
  });

  // ── the audit view ───────────────────────────────────────────────────────
  describe("GET /cases/:id/audit", () => {
    it("returns the query log and the scope changes together", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/audit`,
      });
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.authorizationRef).toBe(AUTH_REF);
      expect(body.totals.denied).toBeGreaterThan(0);
      expect(body.queryLogs.length).toBeGreaterThan(0);
      expect(
        body.events.some((e: { action: string }) => e.action === "scope.added"),
      ).toBe(true);
    });
  });
});

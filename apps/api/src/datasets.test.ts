/**
 * Phase 4 exit-gate tests, plus the per-subject-kind gate they introduced.
 *
 * The gating tests matter most: Intelligence X is the first source that is
 * free for one subject kind and gated for another, so every layer — planner,
 * dispatcher, adapter, audit row — has to agree on which applies.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@scout/db";
import { clearResponseCache } from "./adapters/base.js";
import { infraRateLimiter } from "./lib/ratelimit.js";

const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

const INTELX_SEARCH = { id: "search-1" };
const INTELX_RESULT = {
  status: 0,
  records: [
    {
      systemid: "abc-123",
      name: "combolist_2026.txt",
      description: "contact ops@example.com and files.example.com",
      date: "2026-01-02T00:00:00",
      bucket: "leaks.public",
      media: 1,
      typeh: "text",
    },
  ],
};

const SANCTIONS = {
  results: [
    {
      id: "NK-abc",
      caption: "Jane Designated",
      schema: "Person",
      datasets: ["us_ofac_sdn"],
      score: 0.94,
      properties: {
        country: ["ru"],
        topics: ["sanction"],
        email: ["jane@example.org"],
        website: [],
        name: ["Jane Designated"],
      },
    },
  ],
};

const realFetch = globalThis.fetch;

function stubFetch() {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (url.includes("/intelligent/search/result")) return json(INTELX_RESULT);
    if (url.includes("/intelligent/search")) return json(INTELX_SEARCH);
    if (url.startsWith("https://api.opensanctions.org/")) return json(SANCTIONS);
    throw new Error(`unexpected upstream call: ${url}`);
  }) as typeof fetch;
}

let app: FastifyInstance;
let caseId: string;
const AUTH_REF = `DATASETS-${Date.now()}`;

run("Scout datasets tier", () => {
  beforeAll(async () => {
    process.env["INTELX_API_KEY"] = "test-intelx-key";
    process.env["OPENSANCTIONS_API_KEY"] = "test-os-key";

    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/cases",
      payload: {
        name: "Datasets",
        authorizationRef: AUTH_REF,
        scope: [{ kind: "domain", value: "example.com" }],
      },
    });
    caseId = created.json().id;
  });

  beforeEach(() => {
    stubFetch();
    clearResponseCache();
    infraRateLimiter.reset();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
    delete process.env["INTELX_API_KEY"];
    delete process.env["OPENSANCTIONS_API_KEY"];
  });

  // ── per-subject-kind gating ─────────────────────────────────────────────
  describe("Intelligence X is gated per subject kind", () => {
    it("runs freely for a domain subject, with no confirmation", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/datasets/intelligence-x",
        payload: { caseId, subject: { kind: "domain", value: "example.com" } },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.scopeGated).toBe(false);
      expect(body.status).toBe("ok");
      expect(body.observations[0].datasetId).toBe("leaks.public");
    });

    it("requires confirmation for an email selector", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/datasets/intelligence-x",
        payload: {
          caseId,
          subject: { kind: "email", value: "bob@example.com" },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toMatch(/scope-gated/i);
    });

    it("applies the scope gate to an email selector", async () => {
      // In scope via the domain entry, so it runs.
      const inScope = await app.inject({
        method: "POST",
        url: "/datasets/intelligence-x",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "email", value: "bob@example.com" },
        },
      });
      expect(inScope.statusCode).toBe(200);
      expect(inScope.json().scopeGated).toBe(true);

      // Out of scope, so the same source that ran freely for a domain is
      // refused for a person.
      const outOfScope = await app.inject({
        method: "POST",
        url: "/datasets/intelligence-x",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "email", value: "victim@unrelated.net" },
        },
      });
      expect(outOfScope.statusCode).toBe(403);
      expect(outOfScope.json().reason).toBe("out-of-scope");
    });

    it("records the effective gate on the audit row, not the source flag", async () => {
      const domainRow = await prisma.queryLog.findFirst({
        where: {
          caseId,
          sourceId: "intelligence-x",
          subjectKind: "DOMAIN",
          phase: "EXECUTE",
        },
        orderBy: { createdAt: "desc" },
      });
      const emailRow = await prisma.queryLog.findFirst({
        where: {
          caseId,
          sourceId: "intelligence-x",
          subjectKind: "EMAIL",
          phase: "EXECUTE",
        },
        orderBy: { createdAt: "desc" },
      });

      // Same source, different answer — which is the whole point.
      expect(domainRow?.requiresScope).toBe(false);
      expect(emailRow?.requiresScope).toBe(true);
    });

    it("writes a DENIED row for the refused email lookup", async () => {
      const denial = await prisma.queryLog.findFirst({
        where: {
          caseId,
          sourceId: "intelligence-x",
          outcome: "DENIED",
          subjectValue: "victim@unrelated.net",
        },
      });
      expect(denial).not.toBeNull();
      expect(denial?.reason).toBe("out-of-scope");
      expect(denial?.requiresScope).toBe(true);
    });

    it("plans an email selector as scoped and a domain as not", async () => {
      const emailPlan = await app.inject({
        method: "POST",
        url: "/query",
        payload: {
          caseId,
          subject: { kind: "email", value: "bob@example.com" },
        },
      });
      const intelxEmail = emailPlan
        .json()
        .plan.find((e: { sourceId: string }) => e.sourceId === "intelligence-x");
      expect(intelxEmail.requiresScope).toBe(true);
      expect(intelxEmail.matchedScope.value).toBe("example.com");

      const domainPlan = await app.inject({
        method: "POST",
        url: "/query",
        payload: { caseId, subject: { kind: "domain", value: "example.com" } },
      });
      const intelxDomain = domainPlan
        .json()
        .plan.find((e: { sourceId: string }) => e.sourceId === "intelligence-x");
      expect(intelxDomain.requiresScope).toBe(false);
    });

    it("cannot be swept with an email even if it reached the sweep", async () => {
      // intelligence-x is not an infra adapter, so the sweep rejects it by
      // name. The per-kind guard is the second line, tested directly in
      // invariants.test.ts.
      const response = await app.inject({
        method: "POST",
        url: "/infra/sweep",
        payload: {
          caseId,
          confirm: true,
          sourceIds: ["intelligence-x"],
          subject: { kind: "email", value: "bob@example.com" },
        },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ── OpenSanctions ───────────────────────────────────────────────────────
  describe("OpenSanctions", () => {
    it("returns matches with dataset provenance and a sanctioned flag", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/datasets/opensanctions",
        payload: {
          caseId,
          subject: { kind: "person", value: "Jane Designated" },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe("ok");
      expect(body.scopeGated).toBe(false);

      const match = body.observations[0];
      expect(match.kind).toBe("sanction-match");
      expect(match.datasets).toEqual(["us_ofac_sdn"]);
      expect(match.sanctioned).toBe(true);
      expect(body.totals.sanctioned).toBe(1);
    });

    it("suggests candidate subjects without linking them into the case", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/datasets/opensanctions",
        payload: {
          caseId,
          subject: { kind: "person", value: "Jane Designated" },
        },
      });
      const body = response.json();

      expect(body.suggestedSubjects.length).toBeGreaterThan(0);
      expect(
        body.suggestedSubjects.some(
          (e: { value: string }) => e.value === "jane@example.org",
        ),
      ).toBe(true);

      // Suggestions only — nothing was written to the case.
      const subjects = await prisma.subject.findMany({ where: { caseId } });
      expect(subjects.map((s) => s.value)).not.toContain("jane@example.org");
    });
  });

  // ── the sweep, and what it refuses to sweep ─────────────────────────────
  describe("dataset sweep", () => {
    it("batches the sources that are ungated for this subject kind", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/datasets/sweep",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "person", value: "Jane Designated" },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(
        body.sources.map((s: { sourceId: string }) => s.sourceId),
      ).toEqual(["opensanctions"]);
      expect(body.totals.sanctioned).toBe(1);

      // Intelligence X does not accept a person subject, and says so rather
      // than just being absent.
      const intelx = body.excluded.find(
        (e: { sourceId: string }) => e.sourceId === "intelligence-x",
      );
      expect(intelx.reason).toBe("kind-not-accepted");
    });

    it("excludes a per-kind gated source and reports why", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/datasets/sweep",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "email", value: "bob@example.com" },
        },
      });

      expect(response.statusCode).toBe(400);
      // Only IntelX accepts email, and it is gated for it — so there is
      // nothing to sweep, and the refusal says so instead of returning an
      // empty result set that would read as "no hits".
      expect(response.json().message).toMatch(/scope-gated/);
    });

    it("never runs a gated source even when named explicitly", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/datasets/sweep",
        payload: {
          caseId,
          confirm: true,
          sourceIds: ["intelligence-x"],
          subject: { kind: "email", value: "bob@example.com" },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toMatch(/scope-gated/);
    });

    it("still sweeps a source that is gated for a different kind", async () => {
      // Same source, domain subject — ungated, so it runs.
      const response = await app.inject({
        method: "POST",
        url: "/datasets/sweep",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "domain", value: "example.com" },
        },
      });
      expect(response.statusCode).toBe(200);
      expect(
        response.json().sources.map((s: { sourceId: string }) => s.sourceId),
      ).toContain("intelligence-x");
    });

    it("requires an explicit confirmation", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/datasets/sweep",
        payload: {
          caseId,
          subject: { kind: "person", value: "Jane Designated" },
        },
      });
      expect(response.statusCode).toBe(400);
    });

    it("writes no audit row for an excluded source", async () => {
      const before = await prisma.queryLog.count({
        where: { caseId, sourceId: "intelligence-x" },
      });
      await app.inject({
        method: "POST",
        url: "/datasets/sweep",
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "person", value: "Someone Else" },
        },
      });
      const after = await prisma.queryLog.count({
        where: { caseId, sourceId: "intelligence-x" },
      });
      // Nothing was attempted, so there is nothing to record.
      expect(after).toBe(before);
    });
  });

  // ── shared route behaviour ──────────────────────────────────────────────
  describe("dataset routes", () => {
    it("404s for a source with no adapter", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/datasets/opencorporates",
        payload: {
          caseId,
          subject: { kind: "company", value: "Someone Ltd" },
        },
      });
      expect(response.statusCode).toBe(404);
    });

    it("refuses a subject kind the source does not accept", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/datasets/opensanctions",
        payload: { caseId, subject: { kind: "ip", value: "203.0.113.1" } },
      });
      expect(response.statusCode).toBe(400);
    });

    it("reports which kinds trigger the gate", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/datasets/adapters",
      });
      const intelx = response
        .json()
        .adapters.find((a: { sourceId: string }) => a.sourceId === "intelligence-x");
      expect(intelx.requiresScope).toBe(false);
      expect(intelx.scopedKinds).toEqual(["email"]);
    });

    it("saves a dataset finding with its tier from the registry", async () => {
      const saved = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/findings`,
        payload: {
          sourceId: "opensanctions",
          title: "Jane Designated — OFAC SDN",
          queryTerm: "Jane Designated",
          queryKind: "person",
          data: { datasets: ["us_ofac_sdn"], sanctioned: true },
        },
      });
      expect(saved.statusCode).toBe(201);
      expect(saved.json().tier).toBe("DATASETS");
    });
  });
});

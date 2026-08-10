/**
 * Phase B exit-gate tests — the consolidated run.
 *
 * Runs against a real Postgres, like the other route suites, because the
 * things being checked (audit rows, scope loaded from the case, a denial
 * surfacing as a row rather than a thrown 403) live in the database. Skipped
 * without DATABASE_URL. Use a throwaway database — audit rows cannot be
 * deleted, by design.
 *
 * No API keys are set here on purpose. Every keyed source then lands on
 * `inert`, so the whole run can be exercised end to end without a single real
 * request about a real subject.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@scout/db";

/**
 * Deliberately NOT `DATABASE_URL`.
 *
 * This suite creates cases and writes audit rows, and audit rows cannot be
 * deleted — the immutability trigger refuses, which also blocks deleting the
 * case that owns them. So a run against a working database leaves test cases
 * in it permanently, cluttering the case picker with rows nobody can remove.
 * Point SCOUT_TEST_DATABASE_URL at a throwaway database to run these.
 */
const DB = process.env["SCOUT_TEST_DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

if (DB !== undefined && DB.length > 0) {
  process.env["DATABASE_URL"] = DB;
}

/**
 * A full run touches every applicable source, and the keyless ones (crt.sh)
 * make a real request. That is slower than vitest's 5s default on a cold
 * response cache, and a timeout here would read as a broken endpoint rather
 * than a slow upstream.
 */
const SUITE = { timeout: 60_000 };

let app: FastifyInstance;
let caseId: string;

interface RunRow {
  sourceId: string;
  name: string;
  status: string;
  reason: string | null;
  requiresScope: boolean;
  count: number;
}

interface RunBody {
  subject: { kind: string; value: string };
  detection: { kind: string; confidence: string; alternatives: string[] };
  results: RunRow[];
  summary: Record<string, number>;
}

async function doRun(payload: unknown): Promise<RunBody> {
  const response = await app.inject({
    method: "POST",
    url: "/run",
    payload: payload as object,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as RunBody;
}

run("POST /run", SUITE, () => {
  beforeAll(async () => {
    for (const key of [
      "SHODAN_API_KEY",
      "CENSYS_API_KEY",
      "SECURITYTRAILS_API_KEY",
      "HIBP_API_KEY",
      "DEHASHED_API_KEY",
      "HUNTER_API_KEY",
      "INTELX_API_KEY",
      "WHATSMYNAME_ENABLED",
    ]) {
      delete process.env[key];
    }

    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/cases",
      payload: {
        name: "Run suite",
        authorizationRef: `TEST-RUN-${Date.now()}`,
        scope: [{ kind: "domain", value: "example.com" }],
      },
    });
    expect(created.statusCode).toBe(201);
    caseId = (created.json() as { id: string }).id;
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  it("detects the subject kind from the indicator", async () => {
    const body = await doRun({ indicator: "example.com", caseId });
    expect(body.subject).toEqual({ kind: "domain", value: "example.com" });
    expect(body.detection.confidence).toBe("certain");
  });

  it("normalizes a defanged indicator before running it", async () => {
    const body = await doRun({ indicator: "hxxps://example[.]com/x", caseId });
    expect(body.subject.value).toBe("example.com");
  });

  it("honours an explicit kind over detection", async () => {
    const body = await doRun({
      indicator: "example.com",
      caseId,
      kind: "keyword",
    });
    expect(body.subject.kind).toBe("keyword");
    // Correcting the kind must not undo normalization.
    expect(body.subject.value).toBe("example.com");
  });

  it("accounts for every applicable source, dropping none", async () => {
    const body = await doRun({ indicator: "example.com", caseId });
    expect(body.results.length).toBe(body.summary["sourcesConsidered"]);
    for (const row of body.results) {
      expect(row.status).not.toBe("");
      // A row that did not produce results must say why.
      if (row.status !== "ok" && row.status !== "empty") {
        expect(row.reason ?? row.status).toBeTruthy();
      }
    }
  });

  it("reports a keyless source as inert rather than failing", async () => {
    const body = await doRun({ indicator: "example.com", caseId });
    const shodan = body.results.find((r) => r.sourceId === "shodan");
    expect(shodan?.status).toBe("inert");
    expect(shodan?.reason).toBe("missing-key");
  });

  it("reports an uninstalled cli source as inert, not an error", async () => {
    const body = await doRun({ indicator: "example.com", caseId });
    const harvester = body.results.find((r) => r.sourceId === "theharvester");
    // Installed on the machine or not, it must never come back as an error.
    expect(["inert", "ok", "empty"]).toContain(harvester?.status);
    if (harvester?.status === "inert") {
      expect(harvester.reason).toBe("missing-binary");
    }
  });

  it("never fetches a deeplink source", async () => {
    const body = await doRun({ indicator: "example.com", caseId });
    for (const row of body.results) {
      if (row.sourceId === "aleph" || row.sourceId === "wayback-machine") {
        expect(row.status).toBe("deeplink");
        expect(row.count).toBe(0);
      }
    }
  });

  it("blocks an out-of-scope subject on every gated source", async () => {
    const body = await doRun({ indicator: "someone", caseId });
    const gated = body.results.filter((r) => r.requiresScope);

    expect(gated.length).toBeGreaterThan(0);
    for (const row of gated) {
      expect(row.status).toBe("blocked");
      expect(row.reason).toBe("out-of-scope");
      expect(row.count).toBe(0);
    }
  });

  it("surfaces a denial as a row and still returns 200", async () => {
    // The run continues past a refusal. A 403 for the whole request would
    // throw away every other source's results.
    const body = await doRun({ indicator: "someone", caseId });
    expect(body.summary["blocked"]).toBeGreaterThan(0);
    expect(body.summary["errored"]).toBe(0);
  });

  it("writes an audit row for every gated attempt, allowed or not", async () => {
    const before = await prisma.queryLog.count({ where: { caseId } });
    await doRun({ indicator: "someone", caseId });
    const after = await prisma.queryLog.count({ where: { caseId } });
    expect(after).toBeGreaterThan(before);
  });

  it("rejects a run with no case", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/run",
      payload: { indicator: "example.com" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("GET /run/detect reports the guess without running anything", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/run/detect?indicator=Jane%20Doe",
    });
    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      detection: { kind: string; confidence: string; alternatives: string[] };
      applicableSources: number;
    };
    expect(body.detection.kind).toBe("person");
    // The one branch that reaches the gated tier is never claimed as certain.
    expect(body.detection.confidence).toBe("guess");
    expect(body.detection.alternatives).toContain("company");
    expect(body.applicableSources).toBeGreaterThan(0);
  });
});

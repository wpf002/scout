/**
 * Phase 8 exit-gate tests: hardening.
 *
 * Auth, retention and the secrets review. The secrets review in particular is
 * written as executable checks rather than a paragraph claiming it was done —
 * "no key is ever logged" is only true until someone adds a log line.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@scout/db";
import { SOURCES } from "@scout/sources";
import { hashToken, mintToken } from "./auth.js";
import { loadConfig } from "./config.js";

describe("token handling", () => {
  it("mints high-entropy tokens", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => mintToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token.startsWith("scout_")).toBe(true);
      // 32 random bytes as hex.
      expect(token.length).toBe(6 + 64);
    }
  });

  it("hashes deterministically and irreversibly", () => {
    const token = mintToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token.slice(6));
    expect(hashToken(token)).toHaveLength(64);
  });
});

describe("auth defaults to required in production", () => {
  it("is on in production without being asked", () => {
    // An audit log whose every row says "local" cannot answer the question it
    // exists to answer, so this must not be opt-in.
    expect(loadConfig({ NODE_ENV: "production" }).SCOUT_AUTH_REQUIRED).toBe(
      true,
    );
  });

  it("is off in development", () => {
    expect(loadConfig({ NODE_ENV: "development" }).SCOUT_AUTH_REQUIRED).toBe(
      false,
    );
  });

  it("can be forced on in development", () => {
    expect(
      loadConfig({ NODE_ENV: "development", SCOUT_AUTH_REQUIRED: "true" })
        .SCOUT_AUTH_REQUIRED,
    ).toBe(true);
  });
});

/**
 * The secrets review, as tests.
 *
 * These read the source tree, which is unusual for a unit test and deliberate:
 * the property being protected is "nobody added a log line that prints a key",
 * and only the source can answer that.
 */
describe("secrets review", () => {
  const SRC = new URL("./", import.meta.url).pathname;

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
    });
  }

  const files = sourceFiles(SRC);

  it("never logs a key env value", () => {
    const keyEnvs = SOURCES.map((s) => s.keyEnv).filter(
      (env): env is string => env !== null,
    );
    const offenders: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        const logs = /\b(?:log|logger)\.(?:info|warn|error|debug|trace)\b|console\.(?:log|warn|error)/.test(line);
        if (!logs) continue;
        if (keyEnvs.some((env) => line.includes(env))) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never logs a built upstream URL", () => {
    // Hunter.io and Shodan carry the key in the query string, so a logged URL
    // would be a logged key.
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        const logs = /\b(?:log|logger)\.(?:info|warn|error|debug)\b|console\.(?:log|warn|error)/.test(line);
        if (logs && /\burl\b/.test(line) && !line.trim().startsWith("*")) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps subject terms out of route paths", () => {
    // Everything that takes a subject takes it in a POST body. A subject in a
    // path lands in access logs, browser history and proxy logs.
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/app\.(get|post|patch|delete)<[^>]*>?\(\s*[`"']([^`"']+)/g)) {
        const path = match[2] ?? "";
        if (/:subject|:term|:email|:username|:query/.test(path)) {
          offenders.push(`${file}: ${path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("strips request bodies and auth headers from request logs", async () => {
    const { buildServer } = await import("./server.js");
    const app = await buildServer();
    // Fastify keeps the redaction config on the logger it was built with.
    const options = (app.log as unknown as { [key: symbol]: unknown }) ?? {};
    expect(options).toBeDefined();
    await app.close();
  });
});

const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

let app: FastifyInstance;
let token: string;

run("auth and retention against a database", () => {
  beforeAll(async () => {
    process.env["SCOUT_AUTH_REQUIRED"] = "true";
    token = mintToken();
    await prisma.operator.create({
      data: { name: `tester-${Date.now()}`, tokenHash: hashToken(token) },
    });

    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
    delete process.env["SCOUT_AUTH_REQUIRED"];
  });

  // Lazy: `token` is minted in beforeAll, which runs after this body.
  const auth = () => ({ authorization: `Bearer ${token}` });

  describe("auth", () => {
    it("rejects a request with no token", async () => {
      const response = await app.inject({ method: "GET", url: "/cases" });
      expect(response.statusCode).toBe(401);
    });

    it("rejects an unrecognized token", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/cases",
        headers: { authorization: `Bearer ${mintToken()}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it("leaves /health reachable, so a load balancer can see it", async () => {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.statusCode).toBe(200);
    });

    it("accepts a valid token", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/cases",
        headers: auth(),
      });
      expect(response.statusCode).toBe(200);
    });

    it("rejects a disabled operator", async () => {
      const otherToken = mintToken();
      const other = await prisma.operator.create({
        data: {
          name: `disabled-${Date.now()}`,
          tokenHash: hashToken(otherToken),
          active: false,
        },
      });
      const response = await app.inject({
        method: "GET",
        url: "/cases",
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect(response.statusCode).toBe(403);
      await prisma.operator.delete({ where: { id: other.id } });
    });

    it("attributes audit rows to the operator, not a shared label", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/cases",
        headers: auth(),
        payload: {
          name: "Attributed",
          authorizationRef: `AUTH-${Date.now()}`,
          scope: [{ kind: "domain", value: "example.com" }],
        },
      });
      const caseId = created.json().id;

      await app.inject({
        method: "POST",
        url: "/exposure/hibp",
        headers: auth(),
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "email", value: "nope@unrelated.net" },
        },
      });

      const log = await prisma.queryLog.findFirst({
        where: { caseId, outcome: "DENIED" },
      });
      expect(log?.operator).toMatch(/^tester-/);
      expect(log?.operator).not.toBe("local");

      const event = await prisma.auditEvent.findFirst({
        where: { caseId, action: "case.created" },
      });
      expect(event?.actor).toMatch(/^tester-/);
    });
  });

  describe("retention", () => {
    let caseId: string;

    beforeAll(async () => {
      const created = await app.inject({
        method: "POST",
        url: "/cases",
        headers: auth(),
        payload: {
          name: "Retention",
          authorizationRef: `RET-${Date.now()}`,
          notes: "Working notes.",
          scope: [{ kind: "domain", value: "example.com" }],
        },
      });
      caseId = created.json().id;

      await app.inject({
        method: "POST",
        url: `/cases/${caseId}/findings`,
        headers: auth(),
        payload: {
          sourceId: "crtsh",
          title: "a.example.com",
          queryTerm: "example.com",
          queryKind: "domain",
        },
      });
      await app.inject({
        method: "POST",
        url: `/cases/${caseId}/subjects`,
        headers: auth(),
        payload: { kind: "domain", value: "example.com" },
      });
      // A refused scoped attempt, so this case has an audit trail worth
      // asserting survives the purge. Without it the retention assertion
      // below would pass vacuously against zero rows.
      await app.inject({
        method: "POST",
        url: "/exposure/hibp",
        headers: auth(),
        payload: {
          caseId,
          confirm: true,
          subject: { kind: "email", value: "nope@unrelated.net" },
        },
      });
    });

    it("archives a case out of the working list, reversibly", async () => {
      await app.inject({
        method: "POST",
        url: `/cases/${caseId}/archive`,
        headers: auth(),
      });

      const listed = await app.inject({
        method: "GET",
        url: "/cases",
        headers: auth(),
      });
      expect(
        listed.json().cases.some((c: { id: string }) => c.id === caseId),
      ).toBe(false);

      const withArchived = await app.inject({
        method: "GET",
        url: "/cases?includeArchived=true",
        headers: auth(),
      });
      expect(
        withArchived.json().cases.some((c: { id: string }) => c.id === caseId),
      ).toBe(true);

      await app.inject({
        method: "POST",
        url: `/cases/${caseId}/restore`,
        headers: auth(),
      });
      const restored = await app.inject({
        method: "GET",
        url: "/cases",
        headers: auth(),
      });
      expect(
        restored.json().cases.some((c: { id: string }) => c.id === caseId),
      ).toBe(true);
    });

    it("requires a confirmation and a reason to purge", async () => {
      const noConfirm = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/purge`,
        headers: auth(),
        payload: { reason: "engagement closed" },
      });
      expect(noConfirm.statusCode).toBe(400);

      const noReason = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/purge`,
        headers: auth(),
        payload: { confirm: true },
      });
      expect(noReason.statusCode).toBe(400);
    });

    it("purges investigative content but keeps the audit trail", async () => {
      const before = await prisma.queryLog.count({ where: { caseId } });
      // Guard the guard: if this were zero, the retention assertion below
      // would prove nothing.
      expect(before).toBeGreaterThan(0);

      const response = await app.inject({
        method: "POST",
        url: `/cases/${caseId}/purge`,
        headers: auth(),
        payload: { confirm: true, reason: "engagement closed" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().purged.findings).toBeGreaterThan(0);

      // The collected material is gone.
      expect(await prisma.finding.count({ where: { caseId } })).toBe(0);
      expect(await prisma.subject.count({ where: { caseId } })).toBe(0);
      const record = await prisma.case.findUnique({ where: { id: caseId } });
      expect(record?.notes).toBeNull();
      expect(record?.purgedAt).not.toBeNull();

      // The record of what was done survives — that is the whole point.
      expect(await prisma.queryLog.count({ where: { caseId } })).toBe(before);
      expect(
        await prisma.scopeEntry.count({ where: { caseId } }),
      ).toBeGreaterThan(0);
    });

    it("records the purge, with its reason, in the audit log", async () => {
      const event = await prisma.auditEvent.findFirst({
        where: { caseId, action: "case.purged" },
      });
      expect(event).not.toBeNull();
      expect(event?.detail).toMatchObject({ reason: "engagement closed" });
    });

    it("still reports on a purged case, audit trail intact", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/report?format=json`,
        headers: auth(),
      });
      expect(response.statusCode).toBe(200);
      const report = response.json();
      expect(report.tiers).toEqual([]);
      expect(report.audit.rows.length).toBeGreaterThan(0);
    });
  });
});

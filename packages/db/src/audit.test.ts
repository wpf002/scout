import { afterAll, describe, expect, it } from "vitest";
import { requireSource } from "@scout/sources";
import { prisma } from "./client.js";
import { recordQuery, redactSecrets } from "./audit.js";
import { jsonSafe } from "./mappers.js";

describe("redactSecrets — no key ever reaches the audit log", () => {
  const env = { SHODAN_API_KEY: "sk-live-abcdef123456", HIBP_API_KEY: "" };

  it("scrubs a configured key out of upstream error text", () => {
    const scrubbed = redactSecrets(
      "GET failed: key=sk-live-abcdef123456 rejected",
      env,
    );
    expect(scrubbed).toBe("GET failed: key=[REDACTED] rejected");
    expect(scrubbed).not.toContain("sk-live-abcdef123456");
  });

  it("leaves unrelated text alone", () => {
    expect(redactSecrets("HIBP responded 429", env)).toBe("HIBP responded 429");
  });

  it("ignores short or empty values so it cannot scrub half a message", () => {
    expect(redactSecrets("status 503", { SHODAN_API_KEY: "abc" })).toBe(
      "status 503",
    );
  });
});

describe("jsonSafe — counted things survive the JSON boundary", () => {
  it("renders bigints as decimal strings rather than lossy numbers", () => {
    // Cam4: ~10.88 billion records, comfortably past a signed 32-bit int.
    const value = jsonSafe({ pwnCount: 10_880_000_000n });
    expect(value).toEqual({ pwnCount: "10880000000" });
    expect(() => JSON.stringify(value)).not.toThrow();
  });

  it("walks nested structures", () => {
    expect(jsonSafe({ a: [{ n: 1n }], b: 2 })).toEqual({
      a: [{ n: "1" }],
      b: 2,
    });
  });

  it("throws on a raw bigint without it, which is why this helper exists", () => {
    expect(() => JSON.stringify({ n: 1n })).toThrow();
  });
});

const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

run("audit rows are immutable at the database level", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects UPDATE and DELETE on a QueryLog row", async () => {
    const record = await prisma.case.create({
      data: {
        name: "immutability check",
        authorizationRef: `IMMUTABLE-${Date.now()}`,
      },
    });

    const log = await recordQuery({
      caseId: record.id,
      source: requireSource("hibp"),
      subject: { kind: "email", value: "someone@example.com" },
      phase: "EXECUTE",
      outcome: "DENIED",
      reason: "out-of-scope",
      authorizationRef: record.authorizationRef,
    });

    await expect(
      prisma.queryLog.update({
        where: { id: log.id },
        data: { outcome: "ALLOWED", reason: null },
      }),
    ).rejects.toThrow(/immutable/i);

    await expect(
      prisma.queryLog.delete({ where: { id: log.id } }),
    ).rejects.toThrow(/immutable/i);

    // Still there, still saying what it said.
    const after = await prisma.queryLog.findUnique({ where: { id: log.id } });
    expect(after?.outcome).toBe("DENIED");
    expect(after?.reason).toBe("out-of-scope");
  });

  it("rejects deleting a case whose audit trail would go with it", async () => {
    const record = await prisma.case.create({
      data: {
        name: "cascade check",
        authorizationRef: `CASCADE-${Date.now()}`,
      },
    });
    await recordQuery({
      caseId: record.id,
      source: requireSource("hibp"),
      subject: { kind: "email", value: "someone@example.com" },
      phase: "PLAN",
      outcome: "DENIED",
      reason: "scope-empty",
      authorizationRef: record.authorizationRef,
    });

    // The cascade would have to delete the audit rows, and it cannot.
    // Retention is Phase 8, and will archive rather than erase.
    await expect(
      prisma.case.delete({ where: { id: record.id } }),
    ).rejects.toThrow(/immutable/i);
  });
});

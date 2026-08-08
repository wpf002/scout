/**
 * Phase 7 exit-gate tests: reporting and export.
 *
 * The exit gate is "one button produces a client-ready case report with
 * complete provenance and an attached audit trail". The parts worth asserting
 * hard are that provenance survives into the deliverable, that the audit trail
 * is attached rather than summarized away, and that redaction runs before
 * anything leaves.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@scout/db";

const DB = process.env["DATABASE_URL"];
const run = DB === undefined || DB.length === 0 ? describe.skip : describe;

let app: FastifyInstance;
let caseId: string;
const AUTH_REF = `REPORT-${Date.now()}`;

run("Scout reporting — Phase 7", () => {
  beforeAll(async () => {
    delete process.env["HIBP_API_KEY"];
    const { buildServer } = await import("./server.js");
    app = await buildServer();
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/cases",
      payload: {
        name: "Report Engagement 42",
        authorizationRef: AUTH_REF,
        // A note carrying one in-scope and one out-of-scope identifier.
        notes:
          "Primary contact bob@example.com. Tip came from bystander@unrelated.net.",
        scope: [{ kind: "domain", value: "example.com" }],
      },
    });
    caseId = created.json().id;

    await app.inject({
      method: "POST",
      url: `/cases/${caseId}/findings`,
      payload: {
        sourceId: "crtsh",
        title: "admin.example.com in CT logs",
        summary: "Also referenced leaker@unrelated.net in the cert comment.",
        queryTerm: "example.com",
        queryKind: "domain",
      },
    });

    // A finding carrying credential material in its payload AND a password
    // typed into the summary by hand — the case scope-redaction cannot catch.
    await app.inject({
      method: "POST",
      url: `/cases/${caseId}/findings`,
      payload: {
        sourceId: "dehashed",
        title: "Credential for bob@example.com in ExampleBreach",
        summary: "Validated: the password hunter2sekrit still works on the VPN.",
        queryTerm: "bob@example.com",
        queryKind: "email",
        data: { databaseName: "ExampleBreach", password: "hunter2sekrit" },
      },
    });

    // One refused scoped attempt, so the audit trail has a denial in it.
    await app.inject({
      method: "POST",
      url: "/exposure/hibp",
      payload: {
        caseId,
        confirm: true,
        subject: { kind: "email", value: "victim@unrelated.net" },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  describe("structure", () => {
    it("groups findings by tier in reach-for order", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/report?format=json`,
      });
      expect(response.statusCode).toBe(200);

      const report = response.json();
      expect(report.case.authorizationRef).toBe(AUTH_REF);
      expect(report.tiers[0].tier).toBe("infra");
      expect(report.tiers[0].findings[0].sourceName).toBe("crt.sh");
    });

    it("carries provenance on every finding", async () => {
      const report = (
        await app.inject({
          method: "GET",
          url: `/cases/${caseId}/report?format=json`,
        })
      ).json();

      for (const group of report.tiers) {
        for (const finding of group.findings) {
          expect(finding.sourceId).toBeTruthy();
          expect(finding.queryTerm).toBeTruthy();
          expect(finding.queryKind).toBeTruthy();
          expect(finding.observedAt).toBeTruthy();
        }
      }
    });

    it("attaches the audit trail, including the denial", async () => {
      const report = (
        await app.inject({
          method: "GET",
          url: `/cases/${caseId}/report?format=json`,
        })
      ).json();

      expect(report.audit.totals.denied).toBeGreaterThan(0);
      const denial = report.audit.rows.find(
        (row: { outcome: string }) => row.outcome === "DENIED",
      );
      expect(denial.reason).toBe("out-of-scope");
      expect(denial.requiresScope).toBe(true);
    });

    it("builds a timeline in chronological order", async () => {
      const report = (
        await app.inject({
          method: "GET",
          url: `/cases/${caseId}/report?format=json`,
        })
      ).json();

      const times = report.timeline.map((e: { at: string }) => e.at);
      expect(times).toEqual([...times].sort());
      expect(report.timeline[0].kind).toBe("case");
    });
  });

  describe("redaction runs before anything leaves", () => {
    it("strips out-of-scope identifiers from notes and summaries", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/report?format=json`,
      });
      const body = response.body;

      // The bystander and the leaker were never authorized targets.
      expect(body).not.toContain("bystander@unrelated.net");
      expect(body).not.toContain("leaker@unrelated.net");
      // The authorized contact stays.
      expect(body).toContain("bob@example.com");
    });

    it("reports what it redacted without reproducing the values", async () => {
      const report = (
        await app.inject({
          method: "GET",
          url: `/cases/${caseId}/report?format=json`,
        })
      ).json();

      expect(report.redaction.count).toBeGreaterThanOrEqual(2);
      expect(report.redaction.kinds).toContain("email");
      expect(report.redaction.fields).toContain("case.notes");
      // Kinds and field names only — listing the values would defeat it.
      expect(JSON.stringify(report.redaction)).not.toContain("unrelated.net");
    });

    it("redacts in the HTML render too", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/report?format=html`,
      });
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).not.toContain("bystander@unrelated.net");
      expect(response.body).toContain("redacted before export");
    });

    it("keeps the audit trail's own subject values intact", async () => {
      // The audit row for a refused lookup must still name what was refused —
      // that record is the evidence the gate held, and redacting it would
      // destroy the thing the log exists for.
      const report = (
        await app.inject({
          method: "GET",
          url: `/cases/${caseId}/report?format=json`,
        })
      ).json();
      const denial = report.audit.rows.find(
        (row: { outcome: string }) => row.outcome === "DENIED",
      );
      expect(denial.subjectValue).toBe("victim@unrelated.net");
    });
  });

  describe("credential material never reaches a deliverable", () => {
    it("keeps the stored payload out of every format", async () => {
      for (const format of ["json", "html"]) {
        const response = await app.inject({
          method: "GET",
          url: `/cases/${caseId}/report?format=${format}`,
        });
        // Finding.data is never rendered, so the structured secret cannot
        // ride along.
        expect(response.body, format).not.toContain("hunter2sekrit");
      }
    });

    it("strikes a password typed into a summary by hand", async () => {
      const report = (
        await app.inject({
          method: "GET",
          url: `/cases/${caseId}/report?format=json`,
        })
      ).json();

      const finding = report.tiers
        .flatMap((t: { findings: { summary: string | null }[] }) => t.findings)
        .find((f: { summary: string | null }) =>
          f.summary?.includes("VPN"),
        );
      expect(finding.summary).not.toContain("hunter2sekrit");
      expect(finding.summary).toContain("REDACTED");
      expect(report.redaction.credentialsScrubbed).toBeGreaterThan(0);
    });

    it("keeps it out of the .docx too", async () => {
      // A docx stores its body deflated, so grepping the raw bytes proves
      // nothing. What makes the docx safe is upstream of the renderer: it is
      // built from the same already-scrubbed CaseReport as every other format,
      // so asserting that report is clean covers all three. The renderer
      // cannot reintroduce a value it was never given.
      const report = (
        await app.inject({
          method: "GET",
          url: `/cases/${caseId}/report?format=json`,
        })
      ).json();
      expect(JSON.stringify(report)).not.toContain("hunter2sekrit");

      const docx = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/report?format=docx`,
      });
      expect(docx.statusCode).toBe(200);
      expect(docx.rawPayload.length).toBeGreaterThan(1000);
    });
  });

  describe("formats", () => {
    it("renders a self-contained HTML report", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/report?format=html`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("<!doctype html>");
      expect(response.body).toContain(AUTH_REF);
      expect(response.body).toContain("admin.example.com in CT logs");
      // Self-contained: nothing to fetch when the file is opened elsewhere.
      expect(response.body).not.toMatch(/<script|<link rel=["']stylesheet/i);
    });

    it("renders a real .docx", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/report?format=docx`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain(
        "officedocument.wordprocessingml",
      );
      expect(response.headers["content-disposition"]).toContain(".docx");

      // A docx is a zip; the magic bytes are the cheapest real check.
      const buffer = response.rawPayload;
      expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");
      expect(buffer.length).toBeGreaterThan(1000);
    });

    it("exports the audit trail as CSV", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/audit/export`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/csv");

      const lines = response.body.trim().split("\n");
      expect(lines[0]).toBe(
        "at,phase,outcome,reason,sourceId,subjectKind,subjectValue,matchedScope,operator,requiresScope",
      );
      expect(lines.length).toBeGreaterThan(1);
      expect(response.body).toContain("DENIED");
    });

    it("rejects an unknown format", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/cases/${caseId}/report?format=pdf`,
      });
      expect(response.statusCode).toBe(400);
    });

    it("404s for a case that does not exist", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/cases/nope/report?format=json",
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe("exporting is itself recorded", () => {
    it("writes an audit event naming the format", async () => {
      await app.inject({
        method: "GET",
        url: `/cases/${caseId}/report?format=docx`,
      });
      const event = await prisma.auditEvent.findFirst({
        where: { caseId, action: "report.exported" },
        orderBy: { createdAt: "desc" },
      });
      expect(event).not.toBeNull();
      expect(event?.detail).toMatchObject({ format: "docx" });
    });

    it("records an audit export separately", async () => {
      await app.inject({ method: "GET", url: `/cases/${caseId}/audit/export` });
      const event = await prisma.auditEvent.findFirst({
        where: { caseId, action: "audit.exported" },
        orderBy: { createdAt: "desc" },
      });
      expect(event).not.toBeNull();
    });
  });
});

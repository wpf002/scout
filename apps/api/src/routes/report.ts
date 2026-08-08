import type { FastifyInstance } from "fastify";
import { buildCaseReport, type CaseReport } from "../report/build.js";
import { renderReportHtml } from "../report/html.js";
import { renderReportDocx } from "../report/docx.js";
import { recordAuditEvent } from "@scout/db";
import { badRequest } from "../errors.js";
import { logEvent } from "../observability.js";
import { operatorOf } from "../auth.js";

/** RFC 4180 quoting. Audit exports land in spreadsheets. */
function csvCell(value: string | number | boolean | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function auditCsv(report: CaseReport): string {
  const header = [
    "at",
    "phase",
    "outcome",
    "reason",
    "sourceId",
    "subjectKind",
    "subjectValue",
    "matchedScope",
    "operator",
    "requiresScope",
  ];
  const rows = report.audit.rows.map((row) =>
    [
      row.at,
      row.phase,
      row.outcome,
      row.reason,
      row.sourceId,
      row.subjectKind,
      row.subjectValue,
      row.matchedScope,
      row.operator,
      row.requiresScope,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

/** Safe for a Content-Disposition filename. */
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "case"
  );
}

export async function registerReportRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * GET /cases/:id/report — the deliverable.
   *
   * `format` selects the rendering; all three consume the same already-redacted
   * `CaseReport`, so they cannot disagree about what left the building.
   *
   * Exporting is itself recorded. A case's audit trail should show that its
   * contents were taken out of the tool, and when.
   */
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/cases/:id/report",
    async (request, reply) => {
      const format = request.query.format ?? "html";
      if (!["html", "docx", "json"].includes(format)) {
        throw badRequest(`Unknown report format "${format}".`);
      }

      const report = await buildCaseReport(request.params.id);
      const name = `${slug(report.case.name)}-report`;

      await recordAuditEvent({
        caseId: report.case.id,
        action: "report.exported",
        actor: operatorOf(request),
        detail: {
          format,
          findings: report.tiers.reduce((n, t) => n + t.findings.length, 0),
          auditRows: report.audit.totals.total,
          redactedIdentifiers: report.redaction.count,
        },
      });

      logEvent(request.log, "case.exported", {
        caseId: report.case.id,
        format,
        redactedIdentifiers: report.redaction.count,
        credentialsScrubbed: report.redaction.credentialsScrubbed,
      });

      if (format === "json") return report;

      if (format === "docx") {
        const buffer = await renderReportDocx(report);
        return reply
          .header(
            "content-type",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          )
          .header(
            "content-disposition",
            `attachment; filename="${name}.docx"`,
          )
          .send(buffer);
      }

      return reply
        .header("content-type", "text/html; charset=utf-8")
        .header("content-disposition", `inline; filename="${name}.html"`)
        .send(renderReportHtml(report));
    },
  );

  /**
   * GET /cases/:id/audit/export — the scoped-query log as CSV, for engagement
   * records. Separate from the report because retention rules for an audit
   * trail and for an investigative deliverable are rarely the same.
   */
  app.get<{ Params: { id: string } }>(
    "/cases/:id/audit/export",
    async (request, reply) => {
      const report = await buildCaseReport(request.params.id);

      await recordAuditEvent({
        caseId: report.case.id,
        action: "audit.exported",
        actor: operatorOf(request),
        detail: { rows: report.audit.totals.total },
      });

      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header(
          "content-disposition",
          `attachment; filename="${slug(report.case.name)}-audit.csv"`,
        )
        .send(auditCsv(report));
    },
  );
}

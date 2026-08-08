import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { CaseReport } from "./build.js";

const when = (iso: string): string =>
  new Date(iso).toISOString().replace("T", " ").slice(0, 19) + "Z";

const text = (value: string, options: { bold?: boolean; size?: number; color?: string } = {}) =>
  new Paragraph({
    children: [
      new TextRun({
        text: value,
        bold: options.bold ?? false,
        size: options.size ?? 20,
        ...(options.color === undefined ? {} : { color: options.color }),
      }),
    ],
  });

const mono = (value: string) =>
  new Paragraph({
    children: [new TextRun({ text: value, font: "Consolas", size: 18 })],
  });

function table(headers: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        children: headers.map(
          (header) =>
            new TableCell({
              children: [text(header, { bold: true, size: 17 })],
            }),
        ),
      }),
      ...rows.map(
        (row) =>
          new TableRow({
            children: row.map(
              (cell) =>
                new TableCell({ children: [text(cell, { size: 17 })] }),
            ),
          }),
      ),
    ],
  });
}

/**
 * The editable deliverable.
 *
 * A consultant hands a client a document they can annotate, so the report goes
 * out as a real .docx rather than a PDF of a web page. Content is identical to
 * the HTML render — both consume the same already-redacted `CaseReport`, so
 * they cannot disagree about what left the building.
 */
export async function renderReportDocx(report: CaseReport): Promise<Buffer> {
  const findingCount = report.tiers.reduce(
    (sum, group) => sum + group.findings.length,
    0,
  );

  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: report.case.name, heading: HeadingLevel.TITLE }),
    new Paragraph({
      alignment: AlignmentType.LEFT,
      children: [
        new TextRun({
          text: `Case report · generated ${when(report.generatedAt)}`,
          size: 19,
          color: "5B6673",
        }),
      ],
    }),
    new Paragraph({ text: "" }),

    new Paragraph({ text: "Engagement", heading: HeadingLevel.HEADING_1 }),
    table(
      ["Field", "Value"],
      [
        ["Authorization reference", report.case.authorizationRef],
        ["Case ID", report.case.id],
        ["Status", report.case.status],
        ["Opened", `${when(report.case.createdAt)} by ${report.case.createdBy}`],
        ["Findings", String(findingCount)],
        [
          "Logged queries",
          `${report.audit.totals.total} (${report.audit.totals.denied} refused)`,
        ],
      ],
    ),
    new Paragraph({ text: "" }),
  ];

  if (report.case.notes.length > 0) {
    children.push(
      new Paragraph({ text: "Notes", heading: HeadingLevel.HEADING_1 }),
      text(report.case.notes),
      new Paragraph({ text: "" }),
    );
  }

  children.push(
    new Paragraph({
      text: "Authorization scope",
      heading: HeadingLevel.HEADING_1,
    }),
  );
  children.push(
    report.scope.length === 0
      ? text(
          "No scope was set on this case, so no person-facing source could run.",
        )
      : table(
          ["Kind", "Value", "Note"],
          report.scope.map((entry) => [
            entry.kind,
            entry.value,
            entry.note ?? "",
          ]),
        ),
  );
  children.push(new Paragraph({ text: "" }));

  children.push(
    new Paragraph({ text: "Findings", heading: HeadingLevel.HEADING_1 }),
  );
  if (report.tiers.length === 0) {
    children.push(text("No findings were saved on this case."));
  } else {
    for (const group of report.tiers) {
      children.push(
        new Paragraph({ text: group.tier, heading: HeadingLevel.HEADING_2 }),
      );
      for (const finding of group.findings) {
        children.push(text(finding.title, { bold: true }));
        if (finding.summary !== null) children.push(text(finding.summary));
        // Provenance travels with the finding into the deliverable — a
        // finding a client cannot trace is not evidence.
        children.push(
          mono(
            `${finding.sourceName} · ${finding.queryKind}:${finding.queryTerm} · observed ${when(finding.observedAt)} · saved by ${finding.savedBy}${finding.auditLinked ? " · audit-linked" : ""}`,
          ),
        );
        children.push(new Paragraph({ text: "" }));
      }
    }
  }

  children.push(
    new Paragraph({
      text: "Investigation timeline",
      heading: HeadingLevel.HEADING_1,
    }),
    table(
      ["When", "Event", "Detail"],
      report.timeline.map((event) => [when(event.at), event.label, event.detail]),
    ),
    new Paragraph({ text: "" }),

    new Paragraph({ text: "Audit trail", heading: HeadingLevel.HEADING_1 }),
    text(
      `Every query attempt made under this case, allowed or refused. ${report.audit.totals.scopedAttempts} of ${report.audit.totals.total} were scope-gated. These rows are immutable in the source database.`,
    ),
    new Paragraph({ text: "" }),
    table(
      ["When", "Phase", "Outcome", "Source", "Subject", "Basis", "Operator"],
      report.audit.rows.map((row) => [
        when(row.at),
        row.phase,
        row.reason === null ? row.outcome : `${row.outcome} (${row.reason})`,
        row.sourceId,
        row.subjectValue,
        row.matchedScope ?? "—",
        row.operator,
      ]),
    ),
    new Paragraph({ text: "" }),

    new Paragraph({ text: "Redaction", heading: HeadingLevel.HEADING_1 }),
    report.redaction.count > 0
      ? text(
          `${report.redaction.count} out-of-scope identifier${report.redaction.count === 1 ? "" : "s"} were removed from free-text fields before export (kinds: ${report.redaction.kinds.join(", ")}; fields: ${report.redaction.fields.join(", ")}). The values are deliberately not reproduced.`,
        )
      : text(
          "No out-of-scope identifiers were found in free-text fields. Redaction covers identifiers it can positively recognize in notes and summaries; it reduces leakage rather than guaranteeing prose contains nothing sensitive.",
        ),
  );

  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}

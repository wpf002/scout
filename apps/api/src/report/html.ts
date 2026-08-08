import type { CaseReport } from "./build.js";

const escape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const when = (iso: string): string =>
  new Date(iso).toISOString().replace("T", " ").slice(0, 19) + "Z";

/**
 * A self-contained, print-ready case report.
 *
 * No external assets, so it survives being emailed as a single file, and the
 * print stylesheet means "save as PDF" in a browser produces the deliverable
 * without Scout shipping a PDF engine.
 */
export function renderReportHtml(report: CaseReport): string {
  const outcomeClass: Record<string, string> = {
    ALLOWED: "ok",
    DENIED: "deny",
    INERT: "warn",
    ERROR: "deny",
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Scout case report — ${escape(report.case.name)}</title>
<style>
  :root { --ink:#12161c; --dim:#5b6673; --faint:#8a94a1; --line:#d8dee6;
          --ok:#1a7f37; --warn:#9a6700; --deny:#cf222e; }
  * { box-sizing:border-box; }
  body { font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         color:var(--ink); margin:0; padding:44px 52px; max-width:960px; }
  h1 { font-size:24px; margin:0 0 4px; letter-spacing:-0.02em; }
  h2 { font-size:15px; margin:32px 0 10px; padding-bottom:5px;
       border-bottom:1px solid var(--line); letter-spacing:-0.01em; }
  h3 { font-size:13px; margin:18px 0 6px; text-transform:capitalize; }
  .sub { color:var(--dim); margin:0 0 22px; }
  .mono { font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size:.92em; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; margin-bottom:10px; }
  th { text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.05em;
       color:var(--faint); border-bottom:1px solid var(--line); padding:5px 8px 5px 0; }
  td { padding:6px 8px 6px 0; border-bottom:1px solid var(--line); vertical-align:top; }
  .tag { display:inline-block; font-family:ui-monospace,monospace; font-size:10px;
         text-transform:uppercase; letter-spacing:.04em; border:1px solid var(--line);
         border-radius:100px; padding:1px 7px; }
  .ok{color:var(--ok);border-color:var(--ok)} .warn{color:var(--warn);border-color:var(--warn)}
  .deny{color:var(--deny);border-color:var(--deny)}
  .box { border:1px solid var(--line); border-radius:6px; padding:14px 16px; margin-bottom:18px; }
  .box.alert { border-color:var(--warn); background:#fff8e6; }
  dl { display:grid; grid-template-columns:170px 1fr; gap:4px 14px; margin:0; font-size:13px; }
  dt { color:var(--faint); } dd { margin:0; }
  .finding { border-left:3px solid var(--line); padding-left:12px; margin-bottom:14px; }
  .prov { color:var(--faint); font-size:11.5px; margin-top:3px; }
  footer { margin-top:34px; padding-top:12px; border-top:1px solid var(--line);
           color:var(--faint); font-size:11.5px; }
  @media print {
    body { padding:0; }
    h2 { page-break-after:avoid; }
    .finding, tr { page-break-inside:avoid; }
  }
</style>
</head>
<body>
<h1>${escape(report.case.name)}</h1>
<p class="sub">Case report · generated ${when(report.generatedAt)}</p>

<div class="box">
  <dl>
    <dt>Authorization reference</dt><dd class="mono">${escape(report.case.authorizationRef)}</dd>
    <dt>Case ID</dt><dd class="mono">${escape(report.case.id)}</dd>
    <dt>Status</dt><dd>${escape(report.case.status)}</dd>
    <dt>Opened</dt><dd>${when(report.case.createdAt)} by ${escape(report.case.createdBy)}</dd>
    <dt>Findings</dt><dd>${report.tiers.reduce((n, t) => n + t.findings.length, 0)}</dd>
    <dt>Logged queries</dt><dd>${report.audit.totals.total} (${report.audit.totals.denied} refused)</dd>
  </dl>
</div>

${
  report.case.notes.length > 0
    ? `<h2>Notes</h2><p>${escape(report.case.notes)}</p>`
    : ""
}

<h2>Authorization scope</h2>
${
  report.scope.length === 0
    ? `<p class="sub">No scope was set on this case, so no person-facing source could run.</p>`
    : `<table><thead><tr><th>Kind</th><th>Value</th><th>Note</th></tr></thead><tbody>${report.scope
        .map(
          (entry) =>
            `<tr><td>${escape(entry.kind)}</td><td class="mono">${escape(entry.value)}</td><td>${escape(entry.note ?? "")}</td></tr>`,
        )
        .join("")}</tbody></table>`
}

<h2>Findings</h2>
${
  report.tiers.length === 0
    ? `<p class="sub">No findings were saved on this case.</p>`
    : report.tiers
        .map(
          (group) => `<h3>${escape(group.tier)}</h3>${group.findings
            .map(
              (finding) => `<div class="finding">
  <strong>${escape(finding.title)}</strong>
  ${finding.summary === null ? "" : `<div>${escape(finding.summary)}</div>`}
  <div class="prov mono">${escape(finding.sourceName)} · ${escape(finding.queryKind)}:${escape(finding.queryTerm)} · observed ${when(finding.observedAt)} · saved by ${escape(finding.savedBy)}${finding.auditLinked ? " · audit-linked" : ""}</div>
</div>`,
            )
            .join("")}`,
        )
        .join("")
}

<h2>Investigation timeline</h2>
<table><thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead><tbody>
${report.timeline
  .map(
    (event) =>
      `<tr><td class="mono">${when(event.at)}</td><td>${escape(event.label)}</td><td>${escape(event.detail)}</td></tr>`,
  )
  .join("")}
</tbody></table>

<h2>Audit trail</h2>
<p class="sub">Every query attempt made under this case, allowed or refused.
${report.audit.totals.scopedAttempts} of ${report.audit.totals.total} were
scope-gated. These rows are immutable in the source database.</p>
<table><thead><tr><th>When</th><th>Phase</th><th>Outcome</th><th>Source</th><th>Subject</th><th>Basis</th><th>Operator</th></tr></thead><tbody>
${report.audit.rows
  .map(
    (row) => `<tr>
  <td class="mono">${when(row.at)}</td>
  <td>${escape(row.phase)}</td>
  <td><span class="tag ${outcomeClass[row.outcome] ?? ""}">${escape(row.outcome)}</span>${row.reason === null ? "" : `<div class="prov mono">${escape(row.reason)}</div>`}</td>
  <td class="mono">${escape(row.sourceId)}</td>
  <td class="mono">${escape(row.subjectValue)}</td>
  <td class="mono">${escape(row.matchedScope ?? "—")}</td>
  <td>${escape(row.operator)}</td>
</tr>`,
  )
  .join("")}
</tbody></table>

${
  report.redaction.count > 0
    ? `<div class="box alert"><strong>${report.redaction.count} out-of-scope identifier${report.redaction.count === 1 ? "" : "s"} redacted before export.</strong>
<div class="prov">Kinds: ${escape(report.redaction.kinds.join(", "))}. Fields: ${escape(report.redaction.fields.join(", "))}.
The values themselves are deliberately not reproduced here.</div></div>`
    : `<div class="box"><strong>No out-of-scope identifiers were found in free-text fields.</strong>
<div class="prov">Redaction covers identifiers it can positively recognize in notes and summaries. It reduces leakage; it is not a guarantee that prose contains nothing sensitive.</div></div>`
}

<footer>
Generated by Scout. Every finding above carries the source and query that
produced it; every query above is recorded in an append-only audit log.
</footer>
</body>
</html>`;
}

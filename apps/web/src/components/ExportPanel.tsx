"use client";

import type { CaseRecord } from "@/lib/types";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * Turning a case into a deliverable.
 *
 * These are plain links to GET endpoints — the browser opens or downloads
 * them, so there is no upload step and nothing to keep in sync client-side.
 * Every export is recorded in the case's own audit trail: a case should show
 * that its contents left the tool, and when.
 */
export function ExportPanel({ record }: { record: CaseRecord }) {
  const url = (path: string) => `${BASE}/cases/${record.id}${path}`;

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Export</h2>
        <span className="badge">Audited</span>
      </div>

      <p>
        Findings with their sources, plus the query log. Out-of-scope identifiers are stripped.
      </p>

      <div className="row">
        <a href={url("/report?format=html")} target="_blank" rel="noreferrer noopener">
          <button type="button" className="primary">
            Open Report ↗
          </button>
        </a>
        <a href={url("/report?format=docx")}>
          <button type="button">Download .docx</button>
        </a>
        <a href={url("/audit/export")}>
          <button type="button">Audit Trail (CSV)</button>
        </a>
        <a href={url("/report?format=json")} target="_blank" rel="noreferrer noopener">
          <button type="button" className="tiny">
            JSON
          </button>
        </a>
      </div>

      <p className="faint">
        The report prints to PDF. The audit trail exports separately.
      </p>
    </div>
  );
}

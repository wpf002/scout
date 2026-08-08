"use client";

import type { FindingRecord } from "@/lib/types";

/**
 * The findings board. Every row shows where it came from — source, the query
 * that produced it, and when it was observed. There is no way to display a
 * finding without its provenance because the API cannot store one without it.
 */
export function FindingsBoard({ findings }: { findings: FindingRecord[] }) {
  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Findings</h2>
        <span className="badge">{findings.length}</span>
      </div>

      {findings.length === 0 ? (
        <div className="empty">
          Nothing saved yet. Run a plan, then save what matters — provenance is
          attached for you.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Finding</th>
              <th>Source</th>
              <th>Provenance</th>
            </tr>
          </thead>
          <tbody>
            {findings.map((finding) => (
              <tr key={finding.id}>
                <td>
                  <div style={{ fontWeight: 550 }}>{finding.title}</div>
                  {finding.summary !== null && (
                    <div className="dim">{finding.summary}</div>
                  )}
                </td>
                <td>
                  <span className="mono">{finding.sourceId}</span>
                  <div className="faint" style={{ fontSize: 11 }}>
                    {finding.tier.toLowerCase()}
                  </div>
                </td>
                <td className="faint mono" style={{ fontSize: 11 }}>
                  {finding.queryKind.toLowerCase()}:{finding.queryTerm}
                  <br />
                  {new Date(finding.observedAt).toLocaleString()}
                  {finding.queryLogId !== null && (
                    <>
                      <br />
                      audit-linked
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

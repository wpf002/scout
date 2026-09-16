"use client";

import { useEffect, useState } from "react";

import type { FindingRecord } from "@/lib/types";

/**
 * The findings board. Every row shows where it came from — source, the query
 * that produced it, and when it was observed. There is no way to display a
 * finding without its provenance because the API cannot store one without it.
 *
 * Paged, because a person search alone saves a few hundred findings and a
 * single scrolling table buries the recent ones under the run that made them.
 */
const PAGE_SIZE = 25;

export function FindingsBoard({ findings }: { findings: FindingRecord[] }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(findings.length / PAGE_SIZE));

  // A refetch can shrink the list under the cursor; never strand the view past
  // the last page.
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1);
  }, [page, pages]);

  const start = page * PAGE_SIZE;
  const shown = findings.slice(start, start + PAGE_SIZE);

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Findings</h2>
        <span className="badge">{findings.length}</span>
      </div>

      {findings.length === 0 ? (
        <div className="empty">
          Nothing saved yet. Sources are attached automatically.
        </div>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>Finding</th>
                <th>Source</th>
                <th>Provenance</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((finding) => (
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

          {pages > 1 ? (
            <Pager page={page} pages={pages} count={findings.length} start={start} shown={shown.length} onPage={setPage} />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Shared pager. Findings and the audit trail both grow into the hundreds and
 * want the same control: where you are, and a step either way.
 */
export function Pager({
  page,
  pages,
  count,
  start,
  shown,
  onPage,
}: {
  page: number;
  pages: number;
  count: number;
  start: number;
  shown: number;
  onPage: (next: number) => void;
}) {
  return (
    <div className="pager">
      <span className="pager-range">
        {start + 1}–{start + shown} of {count}
      </span>
      <div className="pager-controls">
        <button type="button" onClick={() => onPage(page - 1)} disabled={page === 0}>
          Prev
        </button>
        <span className="pager-page">
          {page + 1} / {pages}
        </span>
        <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pages - 1}>
          Next
        </button>
      </div>
    </div>
  );
}

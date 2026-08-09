"use client";

import { useState } from "react";
import type { AuditView } from "@/lib/types";
import { Loading } from "@/components/Loading";

const OUTCOME_CLASS: Record<string, string> = {
  ALLOWED: "ok",
  DENIED: "deny",
  INERT: "warn",
  ERROR: "deny",
};

/**
 * The accountability view: every scoped query attempt on this case, plus the
 * scope changes that authorized them. Read-only — there is no edit control
 * here, and the database would reject one anyway.
 */
export function AuditPanel({ audit }: { audit: AuditView | null }) {
  const [open, setOpen] = useState(false);

  if (audit === null) {
    return (
      <div className="card">
        <h2>Audit trail</h2>
        <Loading what="the audit log" />
      </div>
    );
  }

  const rows = open ? audit.queryLogs : audit.queryLogs.slice(0, 8);

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Audit trail</h2>
        <div className="row">
          <span className="badge">{audit.totals.returned} queries</span>
          {audit.totals.denied > 0 && (
            <span className="badge deny">{audit.totals.denied} denied</span>
          )}
        </div>
      </div>

      {audit.queryLogs.length === 0 ? (
        <div className="empty">
          No scoped queries yet. Every attempt — allowed or refused — lands here.
        </div>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Phase</th>
                <th>Outcome</th>
                <th>Source</th>
                <th>Subject</th>
                <th>Basis</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="faint mono" style={{ fontSize: 11 }}>
                    {new Date(row.createdAt).toLocaleTimeString()}
                  </td>
                  <td className="mono">{row.phase}</td>
                  <td>
                    <span
                      className={`badge ${OUTCOME_CLASS[row.outcome] ?? ""}`}
                    >
                      {row.outcome}
                    </span>
                    {row.reason !== null && (
                      <div className="faint mono" style={{ fontSize: 10.5 }}>
                        {row.reason}
                      </div>
                    )}
                  </td>
                  <td className="mono">{row.sourceId}</td>
                  <td className="mono" style={{ wordBreak: "break-all" }}>
                    {row.subjectValue}
                  </td>
                  <td className="faint mono" style={{ fontSize: 11 }}>
                    {row.matchedScopeValue ?? "—"}
                    <br />
                    {row.operator}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {audit.queryLogs.length > 8 && (
            <button
              className="tiny"
              style={{ marginTop: 10 }}
              onClick={() => setOpen((current) => !current)}
            >
              {open ? "Show less" : `Show all ${audit.queryLogs.length}`}
            </button>
          )}
        </>
      )}

      {audit.events.length > 0 && (
        <>
          <h3 style={{ marginTop: 20 }}>Case events</h3>
          <table>
            <tbody>
              {audit.events.map((event) => (
                <tr key={event.id}>
                  <td className="faint mono" style={{ fontSize: 11, width: 90 }}>
                    {new Date(event.createdAt).toLocaleTimeString()}
                  </td>
                  <td className="mono">{event.action}</td>
                  <td className="faint" style={{ fontSize: 11 }}>
                    {JSON.stringify(event.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { ScopePanel } from "@/components/ScopePanel";
import { Planner } from "@/components/Planner";
import { InfraBoard } from "@/components/InfraBoard";
import { DatasetBoard } from "@/components/DatasetBoard";
import { FindingsBoard } from "@/components/FindingsBoard";
import { GraphBoard } from "@/components/GraphBoard";
import { AlertFeed } from "@/components/AlertFeed";
import { MonitorPanel } from "@/components/MonitorPanel";
import { TimelineBoard } from "@/components/TimelineBoard";
import { AuditPanel } from "@/components/AuditPanel";
import { ExportPanel } from "@/components/ExportPanel";
import { SUBJECT_KINDS } from "@/lib/types";
import type {
  AuditView,
  CaseRecord,
  FindingRecord,
  PivotRequest,
  SubjectKind,
  SubjectRecord,
} from "@/lib/types";

/**
 * The workspace tabs.
 *
 * Ten stacked cards made the scope panel — the one thing that governs whether
 * anything can run at all — scroll off the top. Scope and subjects therefore
 * live on the tab you land on, and everything else is a deliberate step away
 * from it.
 */
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "collect", label: "Collect" },
  { id: "findings", label: "Findings" },
  { id: "graph", label: "Graph" },
  { id: "watch", label: "Watch" },
  { id: "timeline", label: "Timeline" },
  { id: "audit", label: "Audit" },
  { id: "export", label: "Export" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function CaseWorkspace() {
  const params = useParams<{ id: string }>();
  const caseId = params.id;

  const [record, setRecord] = useState<CaseRecord | null>(null);
  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
  const [findings, setFindings] = useState<FindingRecord[]>([]);
  const [audit, setAudit] = useState<AuditView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alertCount, setAlertCount] = useState(0);

  const [tab, setTab] = useState<TabId>("overview");
  const [pivot, setPivot] = useState<PivotRequest | null>(null);

  const [subjectKind, setSubjectKind] = useState<SubjectKind>("domain");
  const [subjectValue, setSubjectValue] = useState("");

  const refreshFindings = useCallback(async () => {
    const [f, a] = await Promise.all([
      api.listFindings(caseId),
      api.audit(caseId),
    ]);
    setFindings(f.findings);
    setAudit(a);
  }, [caseId]);

  const load = useCallback(async () => {
    try {
      const [c, s, f, a] = await Promise.all([
        api.getCase(caseId),
        api.listSubjects(caseId),
        api.listFindings(caseId),
        api.audit(caseId),
      ]);
      setRecord(c);
      setSubjects(s.subjects);
      setFindings(f.findings);
      setAudit(a);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Failed to load the case.",
      );
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    api
      .alerts(caseId)
      .then((result) => setAlertCount(result.alerts.length))
      .catch(() => setAlertCount(0));
  }, [caseId]);

  async function addSubject(event: React.FormEvent) {
    event.preventDefault();
    try {
      const subject = await api.addSubject(caseId, {
        kind: subjectKind,
        value: subjectValue.trim(),
      });
      setSubjects((current) => [
        ...current.filter((s) => s.id !== subject.id),
        subject,
      ]);
      setSubjectValue("");
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Failed to add subject.",
      );
    }
  }

  if (error !== null && record === null) {
    return (
      <>
        <div className="error">{error}</div>
        <Link href="/cases">← All cases</Link>
      </>
    );
  }

  if (record === null) return <div className="empty">Loading case…</div>;

  const badgeFor = (id: TabId): number | null => {
    if (id === "findings") return findings.length > 0 ? findings.length : null;
    if (id === "watch") return alertCount > 0 ? alertCount : null;
    if (id === "audit") {
      return audit !== null && audit.totals.denied > 0
        ? audit.totals.denied
        : null;
    }
    return null;
  };

  return (
    <>
      <div style={{ marginBottom: 6 }}>
        <Link href="/cases" className="faint">
          ← All cases
        </Link>
      </div>

      <div className="spread">
        <div>
          <h1>{record.name}</h1>
          <p className="dim" style={{ margin: 0 }}>
            Authorized under{" "}
            <span className="mono">{record.authorizationRef}</span> · opened{" "}
            {new Date(record.createdAt).toLocaleDateString()} by{" "}
            {record.createdBy}
          </p>
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {record.scopeEntries.length === 0 && (
            <span className="badge deny">no scope</span>
          )}
          <span className={`badge ${record.status === "ACTIVE" ? "ok" : ""}`}>
            {record.status}
          </span>
        </div>
      </div>

      {record.notes !== null && (
        <p className="dim" style={{ marginTop: 10 }}>
          {record.notes}
        </p>
      )}

      {error !== null && (
        <div className="error" style={{ marginTop: 16 }}>
          {error}
        </div>
      )}

      <nav className="tabs" aria-label="Case sections">
        {TABS.map((entry) => {
          const count = badgeFor(entry.id);
          return (
            <button
              key={entry.id}
              className={`tab ${tab === entry.id ? "active" : ""}`}
              aria-current={tab === entry.id ? "page" : undefined}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
              {count !== null && <span className="tab-count">{count}</span>}
            </button>
          );
        })}
      </nav>

      {tab === "overview" && (
        <>
          <ScopePanel
            record={record}
            onChange={(scopeEntries) => {
              setRecord({ ...record, scopeEntries });
              void refreshFindings();
            }}
          />

          <div className="card">
            <div className="spread" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>Subjects</h2>
              <span className="badge">{subjects.length}</span>
            </div>

            {subjects.length > 0 && (
              <div className="chip-list" style={{ marginBottom: 14 }}>
                {subjects.map((subject) => (
                  <span className="scope-chip" key={subject.id}>
                    <span className="faint">{subject.kind.toLowerCase()}</span>
                    {subject.value}
                  </span>
                ))}
              </div>
            )}

            <form onSubmit={addSubject}>
              <div className="row" style={{ alignItems: "flex-end" }}>
                <div style={{ width: 140 }}>
                  <label htmlFor="new-subject-kind">Kind</label>
                  <select
                    id="new-subject-kind"
                    value={subjectKind}
                    onChange={(e) =>
                      setSubjectKind(e.target.value as SubjectKind)
                    }
                  >
                    {SUBJECT_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1, minWidth: 180 }}>
                  <label htmlFor="new-subject-value">Value</label>
                  <input
                    id="new-subject-value"
                    value={subjectValue}
                    onChange={(e) => setSubjectValue(e.target.value)}
                    placeholder="acme.example"
                  />
                </div>
                <button type="submit" disabled={subjectValue.trim().length === 0}>
                  Track subject
                </button>
              </div>
            </form>
          </div>

          <AlertFeed caseId={caseId} heading="Recent changes" limit={5} />
        </>
      )}

      {tab === "collect" && (
        <>
          {pivot !== null && (
            <div className="notice">
              Carried in from the graph:{" "}
              <span className="mono">
                {pivot.kind} {pivot.value}
              </span>
              . Nothing has run — the forms below are filled, not submitted.
            </div>
          )}
          <Planner
            record={record}
            onFindingSaved={() => void refreshFindings()}
            pivot={pivot}
          />
          <DatasetBoard
            record={record}
            onFindingSaved={() => {
              void refreshFindings();
              void api.listSubjects(caseId).then((s) => setSubjects(s.subjects));
            }}
            pivot={pivot}
          />
          <InfraBoard
            record={record}
            onFindingSaved={() => void refreshFindings()}
            pivot={pivot}
          />
        </>
      )}

      {tab === "findings" && <FindingsBoard findings={findings} />}

      {tab === "graph" && (
        <GraphBoard
          record={record}
          onPivot={(subject, target) => {
            setPivot({ ...subject, nonce: Date.now() });
            setTab(target === "watch" ? "watch" : "collect");
          }}
        />
      )}

      {tab === "watch" && (
        <>
          <MonitorPanel record={record} pivot={pivot} />
          <AlertFeed caseId={caseId} heading="Changes on this case" />
        </>
      )}

      {tab === "timeline" && <TimelineBoard record={record} />}

      {tab === "audit" && <AuditPanel audit={audit} />}

      {tab === "export" && <ExportPanel record={record} />}
    </>
  );
}

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
import { AuditPanel } from "@/components/AuditPanel";
import { SUBJECT_KINDS } from "@/lib/types";
import type {
  AuditView,
  CaseRecord,
  FindingRecord,
  SubjectKind,
  SubjectRecord,
} from "@/lib/types";

export default function CaseWorkspace() {
  const params = useParams<{ id: string }>();
  const caseId = params.id;

  const [record, setRecord] = useState<CaseRecord | null>(null);
  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
  const [findings, setFindings] = useState<FindingRecord[]>([]);
  const [audit, setAudit] = useState<AuditView | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        <Link href="/">← All cases</Link>
      </>
    );
  }

  if (record === null) return <div className="empty">Loading case…</div>;

  return (
    <>
      <div style={{ marginBottom: 6 }}>
        <Link href="/" className="faint">
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
        <span className={`badge ${record.status === "ACTIVE" ? "ok" : ""}`}>
          {record.status}
        </span>
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

      <div style={{ marginTop: 24 }}>
        <ScopePanel
          record={record}
          onChange={(scopeEntries) => {
            setRecord({ ...record, scopeEntries });
            void refreshFindings();
          }}
        />
      </div>

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

      <Planner record={record} onFindingSaved={() => void refreshFindings()} />

      <DatasetBoard
        record={record}
        onFindingSaved={() => {
          void refreshFindings();
          void api.listSubjects(caseId).then((s) => setSubjects(s.subjects));
        }}
      />

      <InfraBoard record={record} onFindingSaved={() => void refreshFindings()} />

      <FindingsBoard findings={findings} />

      <AuditPanel audit={audit} />
    </>
  );
}

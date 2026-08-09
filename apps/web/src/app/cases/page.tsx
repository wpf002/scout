"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import type { CaseRecord } from "@/lib/types";
import { Loading } from "@/components/Loading";

interface ScopeDraft {
  kind: "domain" | "identifier";
  value: string;
}

export default function CasesPage() {
  const [cases, setCases] = useState<CaseRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [name, setName] = useState("");
  const [authorizationRef, setAuthorizationRef] = useState("");
  const [notes, setNotes] = useState("");
  const [scope, setScope] = useState<ScopeDraft[]>([
    { kind: "domain", value: "" },
  ]);

  const load = useCallback(async () => {
    try {
      const result = await api.listCases();
      setCases(result.cases);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Failed to load cases.",
      );
      setCases([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const entries = scope
        .map((s) => ({ kind: s.kind, value: s.value.trim() }))
        .filter((s) => s.value.length > 0);

      const created = await api.createCase({
        name: name.trim(),
        authorizationRef: authorizationRef.trim(),
        ...(notes.trim().length > 0 ? { notes: notes.trim() } : {}),
        ...(entries.length > 0 ? { scope: entries } : {}),
      });

      setName("");
      setAuthorizationRef("");
      setNotes("");
      setScope([{ kind: "domain", value: "" }]);
      setCases((current) => [created, ...(current ?? [])]);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Failed to create case.",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <h1>Cases</h1>
      <p className="lede">
        An investigation is a case. It owns its authorization scope, its
        subjects, its findings, and its audit log — because permission is
        granted per engagement, not per install.
      </p>

      {error !== null && <div className="error">{error}</div>}

      <div className="grid-2">
        <div>
          <div className="card">
            <h2>New case</h2>
            <form onSubmit={create}>
              <div className="field">
                <label htmlFor="case-name">Name</label>
                <input
                  id="case-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Engagement 14 — acme.example"
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="case-auth">
                  Authorization reference (required)
                </label>
                <input
                  id="case-auth"
                  value={authorizationRef}
                  onChange={(e) => setAuthorizationRef(e.target.value)}
                  placeholder="ENG-2026-014 / SOW §3 / ticket URL"
                  required
                />
                <p
                  className="faint"
                  style={{ fontSize: 11.5, margin: "5px 0 0" }}
                >
                  The engagement or permission that authorizes this work. No
                  scoped source can run without it.
                </p>
              </div>

              <div className="field">
                <label>Initial scope (optional — add more later)</label>
                {scope.map((entry, index) => (
                  <div className="row" key={index} style={{ marginBottom: 6 }}>
                    <select
                      aria-label="Scope kind"
                      style={{ width: 130 }}
                      value={entry.kind}
                      onChange={(e) =>
                        setScope((current) =>
                          current.map((s, i) =>
                            i === index
                              ? {
                                  ...s,
                                  kind: e.target.value as ScopeDraft["kind"],
                                }
                              : s,
                          ),
                        )
                      }
                    >
                      <option value="domain">domain</option>
                      <option value="identifier">identifier</option>
                    </select>
                    <input
                      aria-label="Scope value"
                      style={{ flex: 1, minWidth: 160 }}
                      value={entry.value}
                      onChange={(e) =>
                        setScope((current) =>
                          current.map((s, i) =>
                            i === index ? { ...s, value: e.target.value } : s,
                          ),
                        )
                      }
                      placeholder={
                        entry.kind === "domain"
                          ? "acme.example"
                          : "alice@acme.example"
                      }
                    />
                    {scope.length > 1 && (
                      <button
                        type="button"
                        className="tiny"
                        onClick={() =>
                          setScope((current) =>
                            current.filter((_, i) => i !== index),
                          )
                        }
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="tiny"
                  onClick={() =>
                    setScope((current) => [
                      ...current,
                      { kind: "domain", value: "" },
                    ])
                  }
                >
                  + scope entry
                </button>
              </div>

              <div className="field">
                <label htmlFor="case-notes">Notes</label>
                <textarea
                  id="case-notes"
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>

              <button className="primary" type="submit" disabled={creating}>
                {creating ? "Creating…" : "Create case"}
              </button>
            </form>
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Open cases</h2>
            {cases === null && <Loading what="the case list" />}
            {cases !== null && cases.length === 0 && (
              <div className="empty">
                No cases yet. Create one to get started.
              </div>
            )}
            {cases !== null && cases.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Case</th>
                    <th>Scope</th>
                    <th>Queries</th>
                  </tr>
                </thead>
                <tbody>
                  {cases.map((record) => (
                    <tr key={record.id}>
                      <td>
                        <Link href={`/cases/${record.id}`}>{record.name}</Link>
                        <div className="faint mono" style={{ fontSize: 11 }}>
                          {record.authorizationRef}
                        </div>
                      </td>
                      <td>
                        {record.scopeEntries.length === 0 ? (
                          <span className="badge deny">off</span>
                        ) : (
                          <span className="badge ok">
                            {record.scopeEntries.length}
                          </span>
                        )}
                      </td>
                      <td className="mono">{record._count?.queryLogs ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

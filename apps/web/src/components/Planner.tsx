"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { SUBJECT_KINDS, TIER_BLURB, TIER_ORDER } from "@/lib/types";
import type {
  CaseRecord,
  PivotRequest,
  PlanEntry,
  QueryPlan,
  SourceResult,
  SubjectKind,
} from "@/lib/types";

/**
 * The query planner.
 *
 * `/query` returns a plan and runs nothing. Deeplinks render as links the
 * browser opens — the subject term never reaches a Scout-owned request for
 * those. Scoped sources render one Run button each, behind a confirmation
 * that names the subject, the source, the matched scope entry and the
 * authorization reference.
 *
 * There is no "run everything" control anywhere in here, and there should
 * never be one for a scoped source.
 */
export function Planner({
  record,
  onFindingSaved,
  pivot,
}: {
  record: CaseRecord;
  onFindingSaved: () => void;
  /** A subject carried in from the graph. Fills the form; runs nothing. */
  pivot?: PivotRequest | null;
}) {
  const [kind, setKind] = useState<SubjectKind>("domain");
  const [value, setValue] = useState("");
  const [plan, setPlan] = useState<QueryPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);

  const [results, setResults] = useState<Record<string, SourceResult>>({});
  const [denials, setDenials] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PlanEntry | null>(null);
  const [saveFor, setSaveFor] = useState<string | null>(null);

  // A pivot fills the form and clears the previous plan. It stops there on
  // purpose: arriving from the graph is not a confirmation, and the whole
  // point of the planner is that nothing runs until someone presses Run.
  useEffect(() => {
    if (pivot === undefined || pivot === null) return;
    setKind(pivot.kind);
    setValue(pivot.value);
    setPlan(null);
    setResults({});
    setDenials({});
  }, [pivot]);

  async function runPlan(event: React.FormEvent) {
    event.preventDefault();
    setPlanning(true);
    setError(null);
    setResults({});
    setDenials({});
    try {
      const result = await api.plan({
        caseId: record.id,
        subject: { kind, value: value.trim() },
      });
      setPlan(result);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Plan failed.");
      setPlan(null);
    } finally {
      setPlanning(false);
    }
  }

  async function execute(entry: PlanEntry) {
    if (entry.execution === undefined || plan === null) return;
    setConfirm(null);
    setRunning(entry.sourceId);
    try {
      const result = await api.execute(entry.execution.path, {
        caseId: record.id,
        subject: plan.subject,
      });
      setResults((current) => ({ ...current, [entry.sourceId]: result }));
    } catch (caught) {
      // A scope denial is an expected outcome, not a crash. It is shown
      // inline exactly where the run was attempted.
      if (caught instanceof ApiError) {
        setDenials((current) => ({
          ...current,
          [entry.sourceId]: caught.isScopeDenial
            ? `Refused (${caught.reason}): ${caught.message}`
            : caught.message,
        }));
      }
    } finally {
      setRunning(null);
    }
  }

  const byTier = TIER_ORDER.map((tier) => ({
    tier,
    entries: (plan?.plan ?? []).filter((entry) => entry.tier === tier),
  })).filter((group) => group.entries.length > 0);

  return (
    <div className="card">
      <h2>Query planner</h2>

      <form onSubmit={runPlan}>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div style={{ width: 140 }}>
            <label htmlFor="subject-kind">Subject kind</label>
            <select
              id="subject-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as SubjectKind)}
            >
              {SUBJECT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label htmlFor="subject-value">Subject</label>
            <input
              id="subject-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="acme.example"
              required
            />
          </div>
          <button
            className="primary"
            type="submit"
            disabled={planning || value.trim().length === 0}
          >
            {planning ? "Planning…" : "Plan"}
          </button>
        </div>
      </form>

      {error !== null && (
        <div className="error" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}

      {plan !== null && (
        <>
          <div className="notice" style={{ marginTop: 18 }}>
            <strong>Nothing has run.</strong> {plan.note} Scope came from the
            case ({plan.scopeEntryCount}{" "}
            {plan.scopeEntryCount === 1 ? "entry" : "entries"}). {plan.counts.deeplink}{" "}
            deeplink · {plan.counts.ready} ready · {plan.counts.inert} inert ·{" "}
            {plan.counts.blocked} blocked
          </div>

          {byTier.map(({ tier, entries }) => (
            <section key={tier}>
              <div className="tier-head">
                <span className="n">{TIER_ORDER.indexOf(tier) + 1}</span>
                <h2>{tier}</h2>
                <span className="blurb">{TIER_BLURB[tier]}</span>
              </div>

              {entries.map((entry) => {
                const result = results[entry.sourceId];
                const denial = denials[entry.sourceId];

                return (
                  <div className={`entry ${entry.status}`} key={entry.sourceId}>
                    <div className="spread">
                      <div>
                        <div className="entry-title">{entry.name}</div>
                        {entry.matchedScope !== undefined && (
                          <div className="entry-desc faint">
                            in scope via{" "}
                            <span className="mono">
                              {entry.matchedScope.value}
                            </span>
                          </div>
                        )}
                      </div>

                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        {entry.requiresScope && (
                          <span className="badge scoped">scoped</span>
                        )}

                        {entry.status === "deeplink" && (
                          <>
                            <span className="badge accent">deeplink</span>
                            <a
                              href={entry.url}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              <button type="button">Open ↗</button>
                            </a>
                          </>
                        )}

                        {entry.status === "ready" && (
                          <button
                            className="primary"
                            disabled={running === entry.sourceId}
                            onClick={() => setConfirm(entry)}
                          >
                            {running === entry.sourceId ? "Running…" : "Run"}
                          </button>
                        )}

                        {entry.status === "blocked" && (
                          <span className="badge deny">blocked</span>
                        )}
                        {entry.status === "inert" && (
                          <span className="badge warn">inert</span>
                        )}
                        {entry.status === "no-adapter" && (
                          <span className="badge">no adapter</span>
                        )}
                      </div>
                    </div>

                    {entry.status === "deeplink" && (
                      <div className="entry-note">
                        Opens in your browser. The subject term never passes
                        through Scout for this source.
                      </div>
                    )}

                    {entry.message !== undefined && (
                      <div
                        className={`entry-note${
                          entry.status === "blocked" ? " deny" : ""
                        }`}
                      >
                        {entry.reason !== undefined && (
                          <span className="mono">[{entry.reason}] </span>
                        )}
                        {entry.message}
                      </div>
                    )}

                    {denial !== undefined && (
                      <div className="entry-note deny">{denial}</div>
                    )}

                    {result !== undefined && (
                      <div className="entry-note">
                        <div className="row">
                          <span
                            className={`badge ${
                              result.status === "ok" ? "ok" : "warn"
                            }`}
                          >
                            {result.status}
                          </span>
                          <span>{result.message ?? "Returned data."}</span>
                        </div>
                        <div className="faint mono" style={{ marginTop: 6 }}>
                          {result.provenance.sourceName} ·{" "}
                          {result.provenance.queryTerm} ·{" "}
                          {new Date(
                            result.provenance.observedAt,
                          ).toLocaleString()}
                        </div>
                        {result.status === "ok" && (
                          <pre
                            className="mono"
                            style={{
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              marginTop: 8,
                              maxHeight: 220,
                              overflow: "auto",
                            }}
                          >
                            {JSON.stringify(result.data, null, 2)}
                          </pre>
                        )}
                      </div>
                    )}

                    {(entry.status === "deeplink" || result !== undefined) && (
                      <div style={{ marginTop: 8 }}>
                        {saveFor === entry.sourceId ? (
                          <SaveFinding
                            caseId={record.id}
                            sourceId={entry.sourceId}
                            queryTerm={plan.subject.value}
                            queryKind={plan.subject.kind}
                            queryLogId={result?.provenance.queryLogId}
                            onDone={() => {
                              setSaveFor(null);
                              onFindingSaved();
                            }}
                            onCancel={() => setSaveFor(null)}
                          />
                        ) : (
                          <button
                            className="tiny"
                            onClick={() => setSaveFor(entry.sourceId)}
                          >
                            + Save finding
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </>
      )}

      {confirm !== null && plan !== null && (
        <div className="backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Run a scoped source</h2>
            <p className="dim" style={{ fontSize: 13 }}>
              This is a person-facing lookup. It runs once, for this subject
              only, and the attempt is written to the case&rsquo;s audit log
              either way.
            </p>

            <div className="confirm-table">
              <div>
                <dt>Source</dt>
                <dd>{confirm.name}</dd>
              </div>
              <div>
                <dt>Subject</dt>
                <dd className="mono">
                  {plan.subject.kind}: {plan.subject.value}
                </dd>
              </div>
              <div>
                <dt>Matched scope</dt>
                <dd className="mono">
                  {confirm.matchedScope?.value ?? "—"}
                </dd>
              </div>
              <div>
                <dt>Authorization</dt>
                <dd className="mono">{record.authorizationRef}</dd>
              </div>
            </div>

            <div className="row">
              <button className="primary" onClick={() => void execute(confirm)}>
                Run once
              </button>
              <button onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Saves a finding. Provenance — source, query term, query kind, and the audit
 * row when the result came from a Scout call — is attached automatically and
 * is not editable here, so a finding cannot claim an origin it does not have.
 */
function SaveFinding({
  caseId,
  sourceId,
  queryTerm,
  queryKind,
  queryLogId,
  onDone,
  onCancel,
}: {
  caseId: string;
  sourceId: string;
  queryTerm: string;
  queryKind: SubjectKind;
  queryLogId?: string | undefined;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    try {
      await api.saveFinding(caseId, {
        sourceId,
        title: title.trim(),
        ...(summary.trim().length > 0 ? { summary: summary.trim() } : {}),
        queryTerm,
        queryKind,
        ...(queryLogId !== undefined ? { queryLogId } : {}),
      });
      onDone();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Failed to save finding.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="entry-note">
      {error !== null && <div className="error">{error}</div>}
      <div className="field">
        <label htmlFor={`t-${sourceId}`}>What did you find?</label>
        <input
          id={`t-${sourceId}`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="admin.acme.example resolves to 203.0.113.10"
        />
      </div>
      <div className="field">
        <label htmlFor={`s-${sourceId}`}>Detail</label>
        <textarea
          id={`s-${sourceId}`}
          rows={2}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>
      <div className="faint mono" style={{ fontSize: 11, marginBottom: 8 }}>
        provenance: {sourceId} · {queryKind}:{queryTerm}
        {queryLogId !== undefined ? " · audit-linked" : ""}
      </div>
      <div className="row">
        <button
          className="primary tiny"
          disabled={pending || title.trim().length === 0}
          onClick={() => void save()}
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button className="tiny" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

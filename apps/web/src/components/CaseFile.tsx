"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, ApiError } from "@/lib/api";
import { titleCase } from "@/lib/label";
import { Loading } from "@/components/Loading";
import { ScopePanel } from "@/components/ScopePanel";
import { Planner } from "@/components/Planner";
import { InfraBoard } from "@/components/InfraBoard";
import { DatasetBoard } from "@/components/DatasetBoard";
import { GraphBoard, type PivotTarget } from "@/components/GraphBoard";
import { TimelineBoard } from "@/components/TimelineBoard";
import { FindingsBoard } from "@/components/FindingsBoard";
import { MonitorPanel } from "@/components/MonitorPanel";
import { AuditPanel } from "@/components/AuditPanel";
import { ReviewQueue } from "@/components/ReviewQueue";
import { RecognitionPanel } from "@/components/RecognitionPanel";
import { AgentPanel } from "@/components/AgentPanel";
import { ExportPanel } from "@/components/ExportPanel";
import type {
  AuditView,
  CaseRecord,
  FindingRecord,
  PivotRequest,
  SubjectKind,
} from "@/lib/types";

/**
 * The case file.
 *
 * Ten boards that all answer to one case, gathered behind one switch rather
 * than ten. Each of these was finished and reachable from nowhere; adding ten
 * more icons to a rail that already had eight would have made the map harder to
 * use in order to make these easier to find, which is not a trade worth making.
 *
 * They are also not ten unrelated screens. Read top to bottom the tabs are an
 * investigation: what you are allowed to touch, what you plan to run, what you
 * ran, what it connected to, when it happened, what you kept, what you are
 * still watching, what the record says you did, and what leaves the building.
 */

type Tab =
  | "scope"
  | "plan"
  | "infra"
  | "datasets"
  | "graph"
  | "review"
  | "recognition"
  | "agent"
  | "timeline"
  | "findings"
  | "monitors"
  | "audit"
  | "export";

const TABS: Array<{ id: Tab; name: string; hint: string }> = [
  { id: "scope", name: "Scope", hint: "What this case is authorised to touch" },
  { id: "plan", name: "Plan", hint: "Choose sources and run them" },
  { id: "infra", name: "Infrastructure", hint: "Sweep hosts, certificates, DNS" },
  { id: "datasets", name: "Datasets", hint: "Bulk and person-facing adapters" },
  { id: "graph", name: "Graph", hint: "How the entities connect" },
  { id: "review", name: "Review", hint: "Pairs the resolution model could not decide" },
  { id: "recognition", name: "Recognition", hint: "Enrolled galleries and 1:N comparison; off unless enabled" },
  { id: "agent", name: "Agent", hint: "What the agent watches and proposes; what you approve" },
  { id: "timeline", name: "Timeline", hint: "What happened, in order" },
  { id: "findings", name: "Findings", hint: "What was kept, with provenance" },
  { id: "monitors", name: "Monitors", hint: "Watches that run on a schedule" },
  { id: "audit", name: "Audit", hint: "Every query, who ran it and why" },
  { id: "export", name: "Export", hint: "The case as a report" },
];

/**
 * Where a pivot from the graph lands.
 *
 * The graph deliberately hands over a subject and nothing else — it never runs
 * the next query itself. Switching to the tab that *can* run it, with the
 * subject already filled, is the whole of the handover.
 */
const PIVOT_TAB: Record<PivotTarget, Tab> = {
  collect: "plan",
  watch: "monitors",
};

export function CaseFile({
  prefillScope,
  onScopeAdded,
}: {
  /**
   * A subject sent here from a lookup that came back "Not Authorized". It opens
   * the scope tab with the value filled in; authorising is still done there.
   */
  prefillScope?: { kind: "domain" | "identifier"; value: string } | null;
  /** Fired once scope is granted, so the caller can go back and re-run. */
  onScopeAdded?: () => void;
} = {}) {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [caseId, setCaseId] = useState("");
  const [record, setRecord] = useState<CaseRecord | null>(null);
  const [tab, setTab] = useState<Tab>(prefillScope != null ? "scope" : "plan");
  const [error, setError] = useState<string | null>(null);

  const [findings, setFindings] = useState<FindingRecord[]>([]);
  const [audit, setAudit] = useState<AuditView | null>(null);
  const [pivot, setPivot] = useState<PivotRequest | null>(null);
  const [reviewCount, setReviewCount] = useState(0);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRef, setNewRef] = useState("");

  /**
   * An investigation needs a name and the authorization it runs under. Both are
   * required by the API, so both are asked for here rather than inventing a
   * placeholder reference that would then sit in the audit log as if it meant
   * something.
   */
  async function createCase() {
    try {
      const created = await api.createCase({
        name: newName.trim(),
        authorizationRef: newRef.trim(),
      });
      const refreshed = await api.listCases();
      setCases(refreshed.cases);
      setCaseId(created.id);
      setCreating(false);
      setNewName("");
      setNewRef("");
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create the investigation.");
    }
  }

  useEffect(() => {
    api
      .listCases()
      .then((loaded) => {
        setCases(loaded.cases);
        setCaseId((current) => current || (loaded.cases[0]?.id ?? ""));
      })
      .catch(() => setCases([]));
  }, []);

  /**
   * The full case, not the list entry.
   *
   * `listCases` returns enough to fill a dropdown; the boards need the scope
   * entries, and ScopePanel edits them. Refetching here rather than in each
   * board keeps one copy, so adding a scope entry updates the tab that shows
   * the entries and the tabs that check them at the same moment.
   */
  const loadCase = useCallback(async () => {
    if (caseId === "") {
      setRecord(null);
      return;
    }
    try {
      setRecord(await api.getCase(caseId));
      setError(null);
    } catch (caught) {
      setRecord(null);
      setError(
        caught instanceof ApiError ? caught.message : "Could not load the case.",
      );
    }
  }, [caseId]);

  useEffect(() => {
    void loadCase();
  }, [loadCase]);

  const loadFindings = useCallback(async () => {
    if (caseId === "") return;
    const loaded = await api.listFindings(caseId).catch(() => ({ findings: [] }));
    setFindings(loaded.findings);
  }, [caseId]);

  const loadAudit = useCallback(async () => {
    if (caseId === "") return;
    setAudit(await api.audit(caseId).catch(() => null));
  }, [caseId]);

  useEffect(() => {
    void loadFindings();
  }, [loadFindings]);

  // The audit view is the largest of these and the least often looked at, so it
  // loads when the tab is opened rather than with the case.
  useEffect(() => {
    if (tab === "audit") void loadAudit();
  }, [tab, loadAudit]);

  const onFindingSaved = useCallback(() => {
    void loadFindings();
    // A saved finding is an audited act; the trail on screen is stale the
    // moment one lands.
    if (tab === "audit") void loadAudit();
  }, [loadFindings, loadAudit, tab]);

  const onPivot = useCallback(
    (subject: { kind: SubjectKind; value: string }, target: PivotTarget) => {
      setPivot({ ...subject, nonce: Date.now() });
      setTab(PIVOT_TAB[target]);
    },
    [],
  );

  const counts = useMemo(
    () => ({
      findings: findings.length,
      scope: record?.scopeEntries.length ?? 0,
    }),
    [findings.length, record?.scopeEntries.length],
  );

  // No early return for an empty list: the header carries the New button, and
  // bailing out before it left the first-run case with no way to create one.
  return (
    <div className="casefile">
      <header className="casefile-head">
        <label>
          Investigation
          <select
            value={caseId}
            onChange={(event) => setCaseId(event.target.value)}
          >
            {cases.length === 0 ? <option value="">None yet</option> : null}
            {cases.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {titleCase(entry.name)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="case-new" onClick={() => setCreating(true)}>
          New
        </button>
        {record !== null ? (
          <span className={`case-status ${record.status.toLowerCase()}`}>
            {titleCase(record.status)}
          </span>
        ) : null}
      </header>

      {creating ? (
        <form
          className="case-new-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createCase();
          }}
        >
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Name"
            aria-label="Investigation name"
            autoFocus
          />
          <input
            value={newRef}
            onChange={(event) => setNewRef(event.target.value)}
            placeholder="Authorization reference"
            aria-label="Authorization reference"
          />
          <button type="submit" disabled={newName.trim() === "" || newRef.trim() === ""}>
            Create
          </button>
          <button type="button" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      ) : null}

      <nav className="casefile-tabs" aria-label="Case sections">
        {TABS.map((entry) => {
          const badge =
            entry.id === "findings"
              ? counts.findings
              : entry.id === "scope"
                ? counts.scope
                : entry.id === "review"
                  ? reviewCount
                  : 0;
          return (
            <button
              key={entry.id}
              className={tab === entry.id ? "on" : undefined}
              onClick={() => setTab(entry.id)}
              title={entry.hint}
              aria-current={tab === entry.id ? "page" : undefined}
            >
              {entry.name}
              {badge > 0 ? <span className="tab-badge">{badge}</span> : null}
            </button>
          );
        })}
      </nav>

      {error !== null ? <p className="error">{error}</p> : null}

      <div className="casefile-body">
        {cases.length === 0 ? (
          <p className="panel-empty">No investigations yet. Press New to create one.</p>
        ) : record === null ? (
          <Loading what="the case" />
        ) : (
          <>
            {tab === "scope" ? (
              <ScopePanel
                record={record}
                onChange={() => void loadCase()}
                onAdded={onScopeAdded}
                prefill={prefillScope}
              />
            ) : null}
            {tab === "plan" ? (
              <Planner
                record={record}
                onFindingSaved={onFindingSaved}
                pivot={pivot}
              />
            ) : null}
            {tab === "infra" ? (
              <InfraBoard
                record={record}
                onFindingSaved={onFindingSaved}
                pivot={pivot}
              />
            ) : null}
            {tab === "datasets" ? (
              <DatasetBoard
                record={record}
                onFindingSaved={onFindingSaved}
                pivot={pivot}
              />
            ) : null}
            {tab === "graph" ? (
              <GraphBoard record={record} onPivot={onPivot} />
            ) : null}
            {tab === "review" ? (
              <ReviewQueue record={record} onCount={setReviewCount} onDecided={onFindingSaved} />
            ) : null}
            {tab === "recognition" ? <RecognitionPanel record={record} onActed={onFindingSaved} /> : null}
            {tab === "agent" ? <AgentPanel record={record} onActed={onFindingSaved} /> : null}
            {tab === "timeline" ? <TimelineBoard record={record} /> : null}
            {tab === "findings" ? <FindingsBoard findings={findings} /> : null}
            {tab === "monitors" ? (
              <MonitorPanel record={record} pivot={pivot} />
            ) : null}
            {tab === "audit" ? <AuditPanel audit={audit} /> : null}
            {tab === "export" ? <ExportPanel record={record} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

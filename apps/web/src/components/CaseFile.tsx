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
 * The case file. Every board for one case, behind seven grouped tabs.
 */

/** A single rendered panel. */
type Panel =
  | "scope"
  | "plan"
  | "infra"
  | "datasets"
  | "graph"
  | "review"
  | "recognition"
  | "agent"
  | "monitors"
  | "timeline"
  | "findings"
  | "audit"
  | "export";

/**
 * Thirteen panels, grouped into the seven things an investigation actually is:
 * what you may touch, collecting, the entities, recognition, what you watch,
 * the record, and what leaves. A group with one panel is a plain tab; a group
 * with several shows a sub-row. This is the whole of the "too many tabs" fix —
 * the panels are unchanged, only how they are reached.
 */
interface Group {
  id: string;
  name: string;
  panels: Array<{ id: Panel; name: string }>;
}

const GROUPS: Group[] = [
  { id: "scope", name: "Scope", panels: [{ id: "scope", name: "Scope" }] },
  {
    id: "collect",
    name: "Collect",
    panels: [
      { id: "plan", name: "Plan" },
      { id: "infra", name: "Infrastructure" },
      { id: "datasets", name: "Datasets" },
    ],
  },
  {
    id: "entities",
    name: "Entities",
    panels: [
      { id: "graph", name: "Graph" },
      { id: "review", name: "Review" },
    ],
  },
  { id: "recognition", name: "Recognition", panels: [{ id: "recognition", name: "Recognition" }] },
  {
    id: "watch",
    name: "Watch",
    panels: [
      { id: "agent", name: "Agent" },
      { id: "monitors", name: "Monitors" },
    ],
  },
  {
    id: "record",
    name: "Record",
    panels: [
      { id: "findings", name: "Findings" },
      { id: "timeline", name: "Timeline" },
      { id: "audit", name: "Audit" },
    ],
  },
  { id: "export", name: "Export", panels: [{ id: "export", name: "Export" }] },
];

const groupOf = (panel: Panel): Group =>
  GROUPS.find((g) => g.panels.some((p) => p.id === panel)) ?? GROUPS[0]!;

/**
 * Where a pivot from the graph lands. The graph hands over a subject and
 * nothing else; switching to the panel that can run it, subject filled, is the
 * handover.
 */
const PIVOT_TAB: Record<PivotTarget, Panel> = {
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
  const [panel, setPanel] = useState<Panel>(prefillScope != null ? "scope" : "plan");
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
    if (panel === "audit") void loadAudit();
  }, [panel, loadAudit]);

  const onFindingSaved = useCallback(() => {
    void loadFindings();
    // A saved finding is an audited act; the trail on screen is stale the
    // moment one lands.
    if (panel === "audit") void loadAudit();
  }, [loadFindings, loadAudit, panel]);

  const onPivot = useCallback(
    (subject: { kind: SubjectKind; value: string }, target: PivotTarget) => {
      setPivot({ ...subject, nonce: Date.now() });
      setPanel(PIVOT_TAB[target]);
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

      {(() => {
        const active = groupOf(panel);
        const groupBadge = (group: Group): number =>
          group.id === "record"
            ? counts.findings
            : group.id === "entities"
              ? reviewCount
              : group.id === "scope"
                ? counts.scope
                : 0;
        const panelBadge = (id: Panel): number =>
          id === "findings"
            ? counts.findings
            : id === "review"
              ? reviewCount
              : id === "scope"
                ? counts.scope
                : 0;
        return (
          <>
            <nav className="casefile-tabs" aria-label="Case sections">
              {GROUPS.map((group) => {
                const badge = groupBadge(group);
                return (
                  <button
                    key={group.id}
                    className={active.id === group.id ? "on" : undefined}
                    onClick={() => setPanel(group.panels[0]!.id)}
                    aria-current={active.id === group.id ? "page" : undefined}
                  >
                    {group.name}
                    {badge > 0 ? <span className="tab-badge">{badge}</span> : null}
                  </button>
                );
              })}
            </nav>

            {active.panels.length > 1 ? (
              <nav className="casefile-subtabs" aria-label={`${active.name} sections`}>
                {active.panels.map((sub) => {
                  const badge = panelBadge(sub.id);
                  return (
                    <button
                      key={sub.id}
                      className={panel === sub.id ? "on" : undefined}
                      onClick={() => setPanel(sub.id)}
                      aria-current={panel === sub.id ? "page" : undefined}
                    >
                      {sub.name}
                      {badge > 0 ? <span className="tab-badge">{badge}</span> : null}
                    </button>
                  );
                })}
              </nav>
            ) : null}
          </>
        );
      })()}

      {error !== null ? <p className="error">{error}</p> : null}

      <div className="casefile-body">
        {cases.length === 0 ? (
          <p className="panel-empty">No investigations yet. Press New to create one.</p>
        ) : record === null ? (
          <Loading what="the case" />
        ) : (
          <>
            {panel === "scope" ? (
              <ScopePanel
                record={record}
                onChange={() => void loadCase()}
                onAdded={onScopeAdded}
                prefill={prefillScope}
              />
            ) : null}
            {panel === "plan" ? (
              <Planner
                record={record}
                onFindingSaved={onFindingSaved}
                pivot={pivot}
              />
            ) : null}
            {panel === "infra" ? (
              <InfraBoard
                record={record}
                onFindingSaved={onFindingSaved}
                pivot={pivot}
              />
            ) : null}
            {panel === "datasets" ? (
              <DatasetBoard
                record={record}
                onFindingSaved={onFindingSaved}
                pivot={pivot}
              />
            ) : null}
            {panel === "graph" ? (
              <GraphBoard record={record} onPivot={onPivot} />
            ) : null}
            {panel === "review" ? (
              <ReviewQueue record={record} onCount={setReviewCount} onDecided={onFindingSaved} />
            ) : null}
            {panel === "recognition" ? <RecognitionPanel record={record} onActed={onFindingSaved} /> : null}
            {panel === "agent" ? <AgentPanel record={record} onActed={onFindingSaved} /> : null}
            {panel === "timeline" ? <TimelineBoard record={record} /> : null}
            {panel === "findings" ? <FindingsBoard findings={findings} /> : null}
            {panel === "monitors" ? (
              <MonitorPanel record={record} pivot={pivot} />
            ) : null}
            {panel === "audit" ? <AuditPanel audit={audit} /> : null}
            {panel === "export" ? <ExportPanel record={record} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

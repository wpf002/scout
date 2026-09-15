"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api";
import { titleCase } from "@/lib/label";
import { Loading } from "@/components/Loading";
import { stamp } from "@/lib/investigation";
import { ACTION_KINDS, v2, type ActionKind, type AgentProposal, type Entity, type GraphAlert, type GraphMonitor } from "@/lib/v2";
import type { CaseRecord } from "@/lib/types";

/**
 * The agent's screen: what it watches (monitors), what it saw (alerts),
 * what it proposes, and the one thing only a person does here: approve.
 * Every proposal shows its tier, its evidence and what it would affect
 * before the approve button, because the approval is a record with the
 * approver's name on it and a short life.
 */

const TIER_CLASS = { OBSERVE: "", PREPARE: "warn", CONSEQUENTIAL: "deny" } as const;
const STATUS_CLASS = { PROPOSED: "warn", APPROVED: "scoped", EXECUTED: "ok", REJECTED: "", REFUSED: "deny" } as const;
const KIND_HINT: Record<ActionKind, string> = {
  "draft-report": "Prepare: builds the report file for review. Nothing leaves.",
  "stage-collection": "Prepare: records a collection request. No upstream is called.",
  "assemble-package": "Prepare: gathers what the case holds into one manifest.",
  "dispatch-collection": "Consequential: calls an upstream and writes observations.",
  "send-report": "Consequential: delivers the report outside Scout.",
  "write-external": "Consequential: no writer is registered; refused.",
  "request-scope-expansion": "Sends a request to the issuer.",
};
const describe = (caught: unknown, fallback: string) => (caught instanceof ApiError ? (caught.reason ? `${caught.message} (${caught.reason})` : caught.message) : fallback);

export function AgentPanel({ record, onActed }: { record: CaseRecord; onActed?: () => void }) {
  const caseId = record.id;
  const [proposals, setProposals] = useState<AgentProposal[] | null>(null);
  const [maxTier, setMaxTier] = useState("observe");
  const [monitors, setMonitors] = useState<GraphMonitor[]>([]);
  const [alerts, setAlerts] = useState<GraphAlert[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showPropose, setShowPropose] = useState(false);
  const [showMonitor, setShowMonitor] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, m, a] = await Promise.all([v2.proposals(caseId), v2.monitors(caseId), v2.alerts(caseId)]);
      setProposals(p.proposals);
      setMaxTier(p.maxAutonomousTier);
      setMonitors(m.monitors);
      setAlerts(a.alerts);
      setError(null);
    } catch (caught) {
      setProposals([]);
      setError(describe(caught, "Could not read the agent's record."));
    }
  }, [caseId]);

  useEffect(() => {
    void load();
    v2.entities(caseId).then((r) => setEntities(r.entities)).catch(() => setEntities([]));
  }, [load, caseId]);

  const act = async (key: string, fn: () => Promise<string | null>) => {
    setBusy(key);
    setError(null);
    try {
      const said = await fn();
      if (said !== null) setNotice(said);
      await load();
      onActed?.();
    } catch (caught) {
      setError(describe(caught, "The action did not complete."));
    } finally {
      setBusy(null);
    }
  };

  const labelOf = useMemo(() => new Map(entities.map((e) => [e.id, titleCase(e.canonicalLabel)])), [entities]);

  if (proposals === null) return <Loading what="the agent's record" />;

  return (
    <div className="agent">
      {error !== null ? <p className="error">{error}</p> : null}
      {notice !== null ? <p className="notice">{notice}</p> : null}
      <p className="tiny faint">
        Runs on its own up to <b>{maxTier}</b>. Anything above that waits for your approval.
      </p>

      <div className="spread">
        <h2>Monitors</h2>
        <span className="faint tiny">Stop when the authorization does.</span>
        <button className="tiny agent-right" disabled={busy !== null} onClick={() => void act("tick", async () => { const r = await v2.agentTick(); return `Sweep: ${r.checked} checked, ${r.alerted} alerted, ${r.disabled} disabled, ${r.proposed} proposed.`; })}>
          {busy === "tick" ? "Sweeping…" : "Sweep Now"}
        </button>
        <button className="tiny" onClick={() => setShowMonitor((s) => !s)}>{showMonitor ? "Cancel" : "New Monitor"}</button>
      </div>
      {showMonitor ? (
        <MonitorForm
          entities={entities}
          busy={busy === "monitor"}
          onSubmit={(body) => void act("monitor", async () => { await v2.createMonitor({ caseId, ...body }); setShowMonitor(false); return `Monitor "${body.name}" is watching.`; })}
        />
      ) : null}
      {monitors.length === 0 ? (
        <p className="tiny faint">No watches yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Monitor</th>
              <th>Kind</th>
              <th>Entity</th>
              <th>Last Checked</th>
              <th>Alerts</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {monitors.map((m) => (
              <tr key={m.id} className={m.disabledAt === null ? undefined : "unseen"}>
                <td>{m.name}</td>
                <td>{titleCase(m.kind.replace(/_/g, " "))}</td>
                <td>
                  {labelOf.get(m.params.entityId) ?? <span className="mono">{m.params.entityId}</span>}
                  {m.params.otherEntityId ? <> · {labelOf.get(m.params.otherEntityId) ?? <span className="mono">{m.params.otherEntityId}</span>}</> : null}
                </td>
                <td className="mono faint">{m.lastEvaluatedAt === null ? "—" : stamp(m.lastEvaluatedAt)}</td>
                <td className="mono">{m.alerts}</td>
                <td>{m.disabledAt === null ? <span className="badge ok">Watching</span> : <span className="badge" title={m.disabledReason ?? ""}>Disabled</span>}</td>
                <td>
                  {m.disabledAt === null ? (
                    <button className="tiny" disabled={busy !== null} onClick={() => { const reason = window.prompt("Reason for disabling (recorded):"); if (reason && reason.trim()) void act(`disable:${m.id}`, async () => { await v2.disableMonitor(caseId, m.id, reason.trim()); return null; }); }}>
                      Disable
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Alerts</h3>
      {alerts.length === 0 ? (
        <p className="tiny faint">Nothing has changed under a monitor yet.</p>
      ) : (
        <ul className="agent-alerts">
          {alerts.map((a) => (
            <li key={a.id} className={a.acknowledgedAt === null ? "agent-alert" : "agent-alert unseen"}>
              <span className="mono faint">{stamp(a.at)}</span>
              <span>{a.summary}</span>
              <span className="tiny faint">{a.observationIds.length} observation{a.observationIds.length === 1 ? "" : "s"} cited</span>
              {a.acknowledgedAt === null ? (
                <button className="tiny" disabled={busy !== null} onClick={() => void act(`ack:${a.id}`, async () => { await v2.acknowledgeAlert(caseId, a.id); return null; })}>Acknowledge</button>
              ) : (
                <span className="tiny faint">seen by {a.acknowledgedBy}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="spread">
        <h2>Proposals</h2>
        <span className="faint tiny">Awaiting approval.</span>
        <button className="tiny agent-right" onClick={() => setShowPropose((s) => !s)}>{showPropose ? "Cancel" : "Propose"}</button>
      </div>
      {showPropose ? (
        <ProposeForm
          busy={busy === "propose"}
          onSubmit={(body) => void act("propose", async () => { const p = await v2.propose({ caseId, ...body }); setShowPropose(false); return `Proposed "${p.title}" (${titleCase(p.tier)}).`; })}
        />
      ) : null}
      {proposals.length === 0 ? (
        <p className="tiny faint">No proposals.</p>
      ) : (
        proposals.map((p) => {
          const live = p.approvals.find((a) => a.usedAt === null && new Date(a.expiresAt) > new Date());
          const canExecute = p.status === "PROPOSED" || p.status === "APPROVED";
          return (
            <div key={p.id} className="agent-proposal">
              <div className="spread">
                <b>{p.title}</b>
                <span className={`badge ${TIER_CLASS[p.tier]}`}>{titleCase(p.tier)}</span>
                <span className={`badge ${STATUS_CLASS[p.status]}`}>{titleCase(p.status)}</span>
                <span className="tiny faint">{p.kind} · by {p.proposedBy} · {stamp(p.createdAt)}</span>
              </div>
              <p className="agent-rationale">{p.rationale}</p>
              <p className="tiny faint">
                {KIND_HINT[p.kind]} {typeof p.affects["effect"] === "string" ? "" : ""}
                {Object.keys(p.requiresScope).length > 0 ? ` Requires: ${JSON.stringify(p.requiresScope)}.` : ""}
              </p>
              <div className="claim-cites">
                {p.citations.slice(0, 12).map((id) => (
                  <span className="cite" key={id} title={id}>{id.replace(/^obs_/, "").slice(0, 8)}</span>
                ))}
                {p.citations.length > 12 ? <span className="cite faint">+{p.citations.length - 12}</span> : null}
              </div>
              {p.approvals.length > 0 ? (
                <p className="tiny faint">
                  {p.approvals.map((a) => `${a.usedAt === null ? (new Date(a.expiresAt) > new Date() ? "Approved" : "Approval expired") : "Approval used"} by ${a.approvedBy} at ${stamp(a.approvedAt)} until ${stamp(a.expiresAt)}: ${a.note}`).join(" · ")}
                </p>
              ) : null}
              {p.decisionNote !== null && p.status !== "APPROVED" ? <p className="tiny faint">{titleCase(p.status)} by {p.decidedBy}: {p.decisionNote}</p> : null}
              {p.result !== null ? <pre className="agent-result">{JSON.stringify(p.result, null, 1).slice(0, 1200)}</pre> : null}
              {canExecute ? (
                <div className="review-actions">
                  {live === undefined && p.status === "PROPOSED" ? (
                    <button className="review-decide match" disabled={busy !== null} onClick={() => { const note = window.prompt("Approval note (recorded, single use, expires in 60 minutes):"); if (note && note.trim()) void act(`approve:${p.id}`, async () => { await v2.approveProposal(caseId, p.id, note.trim()); return null; }); }}>
                      Approve
                    </button>
                  ) : null}
                  <button className="review-decide" disabled={busy !== null} onClick={() => void act(`execute:${p.id}`, async () => { const r = await v2.executeProposal(caseId, p.id); return `Executed "${r.title}".`; })}>
                    {busy === `execute:${p.id}` ? "Running…" : "Execute"}
                  </button>
                  <button className="review-decide non_match" disabled={busy !== null} onClick={() => { const reason = window.prompt("Reason for rejecting (recorded):"); if (reason && reason.trim()) void act(`reject:${p.id}`, async () => { await v2.rejectProposal(caseId, p.id, reason.trim()); return null; }); }}>
                    Reject
                  </button>
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}

function MonitorForm({ entities, busy, onSubmit }: { entities: Entity[]; busy: boolean; onSubmit: (body: { kind: GraphMonitor["kind"]; name: string; params: { entityId: string; otherEntityId?: string } }) => void }) {
  const [kind, setKind] = useState<GraphMonitor["kind"]>("NEW_OBSERVATIONS");
  const [name, setName] = useState("");
  const [entityId, setEntityId] = useState("");
  const [otherEntityId, setOtherEntityId] = useState("");
  const sorted = useMemo(() => [...entities].sort((a, b) => a.canonicalLabel.localeCompare(b.canonicalLabel)), [entities]);
  const ready = !busy && name.trim() !== "" && entityId !== "" && (kind !== "CO_LOCATION" || otherEntityId !== "");
  return (
    <form className="recognition-form" onSubmit={(e) => { e.preventDefault(); if (ready) onSubmit({ kind, name: name.trim(), params: { entityId, ...(kind === "CO_LOCATION" ? { otherEntityId } : {}) } }); }}>
      <div className="row">
        <div style={{ width: 190 }}>
          <label htmlFor="mon-kind">Watch For</label>
          <select id="mon-kind" value={kind} onChange={(e) => setKind(e.target.value as GraphMonitor["kind"])}>
            <option value="NEW_OBSERVATIONS">New observations</option>
            <option value="MEMBERSHIP_CHANGE">Membership change</option>
            <option value="CO_LOCATION">Co-location</option>
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <label htmlFor="mon-entity">Entity</label>
          <select id="mon-entity" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            <option value="">Choose…</option>
            {sorted.map((en) => <option key={en.id} value={en.id}>{titleCase(en.canonicalLabel)} · {titleCase(en.kind)}</option>)}
          </select>
        </div>
        {kind === "CO_LOCATION" ? (
          <div style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor="mon-other">With</label>
            <select id="mon-other" value={otherEntityId} onChange={(e) => setOtherEntityId(e.target.value)}>
              <option value="">Choose…</option>
              {sorted.filter((en) => en.id !== entityId).map((en) => <option key={en.id} value={en.id}>{titleCase(en.canonicalLabel)}</option>)}
            </select>
          </div>
        ) : null}
        <div style={{ flex: 1, minWidth: 160 }}>
          <label htmlFor="mon-name">Name</label>
          <input id="mon-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Truck One activity" />
        </div>
        <button type="submit" className="primary" disabled={!ready}>{busy ? "Creating…" : "Watch"}</button>
      </div>
    </form>
  );
}

function ProposeForm({ busy, onSubmit }: { busy: boolean; onSubmit: (body: { kind: ActionKind; title: string; rationale: string; citations: string[]; params: Record<string, unknown> }) => void }) {
  const [kind, setKind] = useState<ActionKind>("draft-report");
  const [title, setTitle] = useState("");
  const [rationale, setRationale] = useState("");
  const [citations, setCitations] = useState("");
  const [params, setParams] = useState("{}");
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(params || "{}") as unknown;
    parsed = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  const ready = !busy && title.trim().length >= 3 && rationale.trim().length >= 8 && parsed !== null;
  return (
    <form className="recognition-form" onSubmit={(e) => { e.preventDefault(); if (ready && parsed !== null) onSubmit({ kind, title: title.trim(), rationale: rationale.trim(), citations: citations.split(/[\s,]+/).map((c) => c.trim()).filter((c) => c !== ""), params: parsed }); }}>
      <div className="row">
        <div style={{ width: 220 }}>
          <label htmlFor="prop-kind">Act</label>
          <select id="prop-kind" value={kind} onChange={(e) => setKind(e.target.value as ActionKind)}>
            {ACTION_KINDS.map((k) => <option key={k} value={k}>{titleCase(k.replace(/-/g, " "))}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="prop-title">Title</label>
          <input id="prop-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What would be done" />
        </div>
      </div>
      <p className="tiny faint">{KIND_HINT[kind]}</p>
      <div className="row">
        <div style={{ flex: 2, minWidth: 240 }}>
          <label htmlFor="prop-why">Why</label>
          <input id="prop-why" value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="What the evidence shows and what this act would add" />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="prop-cites">Cited Observation Ids</label>
          <input id="prop-cites" value={citations} onChange={(e) => setCitations(e.target.value)} placeholder="obs_…, obs_…" />
        </div>
      </div>
      <div className="row">
        <div style={{ flex: 1, minWidth: 240 }}>
          <label htmlFor="prop-params">Parameters (JSON)</label>
          <input id="prop-params" value={params} onChange={(e) => setParams(e.target.value)} placeholder='{"collectorId":"open-web","subject":{"kind":"domain","value":"example.org"}}' />
        </div>
        <button type="submit" className="primary" disabled={!ready}>{busy ? "Proposing…" : "Propose"}</button>
      </div>
    </form>
  );
}

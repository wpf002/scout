"use client";

import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "@/lib/api";
import { KIND_LABEL } from "@/lib/types";
import type { Alert, MonitorRecord, SourceSummary, Subject, SubjectKind } from "@/lib/types";

/**
 * Watch — standing checks that re-run on a schedule and flag what changed.
 *
 * Deliberately small. You type a subject, pick how often, and Scout watches
 * every open source that accepts it; a person cannot be watched, because the
 * API refuses a source that is gated for the subject. Alerts list what appeared
 * or disappeared since the last run. No case ceremony: the watches attach to
 * the one working case, which is never shown.
 */

const WATCHABLE: SubjectKind[] = ["domain", "ip", "hash"];

const CADENCE: Array<{ label: string; minutes: number }> = [
  { label: "Hourly", minutes: 60 },
  { label: "Daily", minutes: 1440 },
  { label: "Weekly", minutes: 10080 },
];

export function WatchPanel() {
  const [caseId, setCaseId] = useState("");
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [monitors, setMonitors] = useState<MonitorRecord[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<SubjectKind>("domain");
  const [minutes, setMinutes] = useState(1440);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listCases().then((r) => setCaseId(r.cases[0]?.id ?? "")).catch(() => setCaseId(""));
    api.sources().then((r) => setSources(r.sources)).catch(() => setSources([]));
  }, []);

  const refresh = useCallback(async () => {
    if (caseId === "") return;
    const [m, a] = await Promise.all([
      api.listMonitors(caseId).catch(() => ({ monitors: [] })),
      api.alerts(caseId).catch(() => ({ alerts: [] })),
    ]);
    setMonitors(m.monitors);
    setAlerts(a.alerts);
  }, [caseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function watch() {
    const subject: Subject = { kind, value: value.trim() };
    if (subject.value === "" || caseId === "" || busy) return;
    // Every open source that accepts this kind — the API rejects any that is
    // gated for it, so no person source can slip in.
    const sourceIds = sources
      .filter((s) => !s.requiresScope && s.mode !== "deeplink" && s.accepts.includes(kind))
      .map((s) => s.id);
    if (sourceIds.length === 0) {
      setError(`No watchable source accepts a ${kind}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createMonitor(caseId, {
        name: `${subject.value} (${kind})`,
        subject,
        sourceIds,
        intervalMinutes: minutes,
      });
      setValue("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not start the watch.");
    } finally {
      setBusy(false);
    }
  }

  async function stop(id: string) {
    if (caseId === "") return;
    await api.deleteMonitor(caseId, id).catch(() => undefined);
    await refresh();
  }

  return (
    <div className="watch-panel">
      <div className="watch-form">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void watch();
          }}
          placeholder="Domain, IP or hash"
          spellCheck={false}
          aria-label="Subject to watch"
        />
        <select value={kind} onChange={(e) => setKind(e.target.value as SubjectKind)} aria-label="Kind">
          {WATCHABLE.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="How often">
          {CADENCE.map((c) => (
            <option key={c.minutes} value={c.minutes}>
              {c.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void watch()} disabled={busy || value.trim() === ""}>
          {busy ? "…" : "Watch"}
        </button>
      </div>

      {error !== null ? <p className="watch-error">{error}</p> : null}

      {monitors.length === 0 ? (
        <p className="panel-empty">Nothing watched yet. A watch re-runs on its schedule and flags changes.</p>
      ) : (
        <ul className="watch-list">
          {monitors.map((m) => (
            <li key={m.id}>
              <div className="w-main">
                <span className="w-subject">{m.subjectValue}</span>
                <span className="w-meta">
                  {m.subjectKind.toLowerCase()} · every{" "}
                  {m.intervalMinutes >= 1440
                    ? `${Math.round(m.intervalMinutes / 1440)}d`
                    : `${Math.round(m.intervalMinutes / 60)}h`}
                  {m._count !== undefined ? ` · ${m._count.changes} changes` : ""}
                </span>
              </div>
              <button type="button" className="w-stop" onClick={() => void stop(m.id)}>
                Stop
              </button>
            </li>
          ))}
        </ul>
      )}

      {alerts.length > 0 ? (
        <div className="watch-alerts">
          <span className="w-alerts-head">Changes</span>
          <ul className="watch-list">
            {alerts.slice(0, 40).map((a) => (
              <li key={a.id}>
                <div className="w-main">
                  <span className="w-subject">
                    <span className={a.changeType === "ADDED" ? "w-added" : "w-removed"}>
                      {a.changeType === "ADDED" ? "+" : "−"}
                    </span>{" "}
                    {a.monitor.subjectValue}
                  </span>
                  <span className="w-meta">
                    {a.observationKind} · {a.sourceIds.join(", ")} · {new Date(a.createdAt).toLocaleString()}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

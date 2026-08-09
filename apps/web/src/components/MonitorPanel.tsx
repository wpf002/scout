"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { SUBJECT_KINDS } from "@/lib/types";
import type {
  CaseRecord,
  MonitorRecord,
  PivotRequest,
  SubjectKind,
} from "@/lib/types";

/**
 * Sources a monitor can draw from — every one of them ungated.
 *
 * The exposure and people tiers are absent entirely. OpenSanctions accepts a
 * person and is still here, which is not an inconsistency: it screens a name
 * against published designation lists, and periodic re-screening is the
 * ordinary use of one. What is refused is the other thing — re-running a
 * breach-exposure or identity-enumeration lookup against someone on a timer.
 */
const WATCHABLE = [
  { id: "crtsh", name: "crt.sh", kinds: ["domain"] },
  { id: "shodan", name: "Shodan", kinds: ["domain", "ip"] },
  { id: "securitytrails", name: "SecurityTrails", kinds: ["domain", "ip"] },
  { id: "censys", name: "Censys", kinds: ["domain", "ip"] },
  { id: "intelligence-x", name: "Intelligence X", kinds: ["domain", "ip", "keyword", "hash"] },
  { id: "opensanctions", name: "OpenSanctions", kinds: ["person", "company", "keyword"] },
];

const INTERVALS = [
  { minutes: 60, label: "hourly" },
  { minutes: 360, label: "every 6 hours" },
  { minutes: 1440, label: "daily" },
  { minutes: 10080, label: "weekly" },
];

/**
 * Standing watches on a case.
 *
 * The source list here contains no person-facing source, and that is not a UI
 * omission — the API refuses to create a monitor on one. Watching a domain's
 * infrastructure change is ordinary recon; putting a person under a recurring
 * automated lookup is standing surveillance, and the confirmation step exists
 * precisely so that nobody does it by accident.
 */
export function MonitorPanel({
  record,
  pivot,
}: {
  record: CaseRecord;
  /** A subject carried in from the graph. Fills the form; watches nothing. */
  pivot?: PivotRequest | null;
}) {
  const [monitors, setMonitors] = useState<MonitorRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [kind, setKind] = useState<SubjectKind>("domain");
  const [value, setValue] = useState("");
  const [sourceIds, setSourceIds] = useState<string[]>(["crtsh"]);
  const [interval, setIntervalMinutes] = useState(1440);

  const load = useCallback(async () => {
    try {
      setMonitors((await api.listMonitors(record.id)).monitors);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Failed to load monitors.",
      );
    }
  }, [record.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Arriving from the graph seeds the form and picks the sources that accept
  // this kind. If none do, the source list stays empty and the submit button
  // stays disabled — which is the honest outcome, not an error.
  useEffect(() => {
    if (pivot === undefined || pivot === null) return;
    setKind(pivot.kind);
    setValue(pivot.value);
    setName(`${pivot.value} watch`);
    setSourceIds(
      WATCHABLE.filter((source) => source.kinds.includes(pivot.kind))
        .slice(0, 1)
        .map((source) => source.id),
    );
  }, [pivot]);

  const eligible = WATCHABLE.filter((source) => source.kinds.includes(kind));

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy("create");
    setError(null);
    try {
      await api.createMonitor(record.id, {
        name: name.trim(),
        subject: { kind, value: value.trim() },
        sourceIds,
        intervalMinutes: interval,
      });
      setName("");
      setValue("");
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Failed to create monitor.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function runNow(monitorId: string) {
    setBusy(monitorId);
    setError(null);
    try {
      const result = await api.runMonitor(record.id, monitorId);
      setError(
        result.baseline
          ? `Baseline recorded — ${result.observationCount} observations. Changes are reported from the next run.`
          : `${result.added} new, ${result.removed} gone.`,
      );
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Run failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Monitors</h2>
        <span className="badge">{monitors.length}</span>
      </div>

      <p className="faint" style={{ fontSize: 12.5, marginTop: 0 }}>
        A standing watch re-runs ungated sources and raises an alert when
        something appears or disappears. Scope-gated sources cannot be
        monitored — breach exposure and identity enumeration run one confirmed
        action at a time, and a recurring automated lookup is the opposite of
        that. The API refuses to create one, so this list is a consequence, not
        a courtesy.
      </p>

      {error !== null && <div className="notice">{error}</div>}

      {monitors.length > 0 && (
        <table style={{ marginBottom: 16 }}>
          <thead>
            <tr>
              <th>Monitor</th>
              <th>Watching</th>
              <th>Last run</th>
              <th>Alerts</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {monitors.map((monitor) => (
              <tr key={monitor.id}>
                <td>
                  <strong>{monitor.name}</strong>
                  <div className="faint" style={{ fontSize: 11 }}>
                    every{" "}
                    {INTERVALS.find((i) => i.minutes === monitor.intervalMinutes)
                      ?.label ?? `${monitor.intervalMinutes}m`}
                    {monitor.enabled ? "" : " · paused"}
                  </div>
                </td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {monitor.subjectValue}
                  <div className="faint">{monitor.sourceIds.join(", ")}</div>
                </td>
                <td className="faint mono" style={{ fontSize: 11 }}>
                  {monitor.lastRunAt === null
                    ? "never"
                    : new Date(monitor.lastRunAt).toLocaleString()}
                </td>
                <td className="mono">{monitor._count?.changes ?? 0}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    className="tiny"
                    disabled={busy !== null}
                    onClick={() => void runNow(monitor.id)}
                  >
                    {busy === monitor.id ? "Running…" : "Run now"}
                  </button>{" "}
                  <button
                    className="tiny"
                    disabled={busy !== null}
                    onClick={async () => {
                      await api.setMonitorEnabled(
                        record.id,
                        monitor.id,
                        !monitor.enabled,
                      );
                      await load();
                    }}
                  >
                    {monitor.enabled ? "Pause" : "Resume"}
                  </button>{" "}
                  <button
                    className="tiny danger"
                    disabled={busy !== null}
                    onClick={async () => {
                      await api.deleteMonitor(record.id, monitor.id);
                      await load();
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={create}>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 150 }}>
            <label htmlFor="mon-name">Name</label>
            <input
              id="mon-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="acme.example perimeter"
              required
            />
          </div>
          <div style={{ width: 120 }}>
            <label htmlFor="mon-kind">Kind</label>
            <select
              id="mon-kind"
              value={kind}
              onChange={(e) => {
                const next = e.target.value as SubjectKind;
                setKind(next);
                setSourceIds(
                  WATCHABLE.filter((s) => s.kinds.includes(next))
                    .slice(0, 1)
                    .map((s) => s.id),
                );
              }}
            >
              {SUBJECT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 150 }}>
            <label htmlFor="mon-value">Subject</label>
            <input
              id="mon-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="acme.example"
              required
            />
          </div>
          <div style={{ width: 140 }}>
            <label htmlFor="mon-interval">Every</label>
            <select
              id="mon-interval"
              value={interval}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
            >
              {INTERVALS.map((i) => (
                <option key={i.minutes} value={i.minutes}>
                  {i.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field" style={{ marginTop: 10 }}>
          <label>Sources</label>
          {eligible.length === 0 ? (
            <div className="faint" style={{ fontSize: 12 }}>
              No watchable source accepts a {kind} subject. Person-facing
              sources are never watchable.
            </div>
          ) : (
            <div className="chip-list">
              {eligible.map((source) => {
                const on = sourceIds.includes(source.id);
                return (
                  <button
                    type="button"
                    key={source.id}
                    className="tiny"
                    style={
                      on
                        ? { borderColor: "var(--accent)", color: "var(--accent)" }
                        : undefined
                    }
                    onClick={() =>
                      setSourceIds((current) =>
                        on
                          ? current.filter((id) => id !== source.id)
                          : [...current, source.id],
                      )
                    }
                  >
                    {source.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          className="primary"
          type="submit"
          disabled={
            busy !== null ||
            sourceIds.length === 0 ||
            value.trim().length === 0 ||
            name.trim().length === 0
          }
        >
          {busy === "create" ? "Creating…" : "Start watching"}
        </button>
      </form>
    </div>
  );
}

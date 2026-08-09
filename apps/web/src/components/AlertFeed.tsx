"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import type { Alert } from "@/lib/types";

/**
 * The alert feed.
 *
 * This is the surface an analyst opens in the morning, so it is built around
 * one question — what changed while I was not looking — and not around a
 * dashboard's usual instinct to show totals. A count of everything Scout has
 * ever seen is not news; a hostname that appeared last night is.
 *
 * Acknowledging is the only disposal. There is no delete: an alert is a
 * recorded observation about a case, and quietly removing one would put a hole
 * in the chronology that the audit log is supposed to make impossible.
 */
export function AlertFeed({
  caseId,
  limit,
  heading = "Alerts",
  onLoaded,
}: {
  /** Scope the feed to one case. Omitted on the dashboard — all cases. */
  caseId?: string;
  limit?: number;
  heading?: string;
  /**
   * Handed the alerts on every load, including after an acknowledgement, so a
   * parent can derive counts without issuing a second request that would go
   * stale the moment something is acknowledged here.
   */
  onLoaded?: (alerts: Alert[]) => void;
}) {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Held in a ref so an inline callback from the caller cannot re-trigger the
  // load effect on every parent render.
  const notify = useRef(onLoaded);
  notify.current = onLoaded;

  const load = useCallback(async () => {
    try {
      const result = await api.alerts(caseId);
      setAlerts(result.alerts);
      notify.current?.(result.alerts);
      setError(null);
    } catch (caught) {
      setAlerts([]);
      setError(
        caught instanceof ApiError ? caught.message : "Failed to load alerts.",
      );
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function acknowledge(ids: string[]) {
    if (ids.length === 0) return;
    setBusy(true);
    try {
      await api.acknowledgeAlerts(ids);
      setSelected(new Set());
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Acknowledge failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const shown = alerts === null ? [] : alerts.slice(0, limit ?? alerts.length);

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{heading}</h2>
        <div className="row">
          {selected.size > 0 && (
            <button
              className="tiny"
              disabled={busy}
              onClick={() => void acknowledge([...selected])}
            >
              Acknowledge {selected.size}
            </button>
          )}
          <span
            className={`badge ${alerts !== null && alerts.length > 0 ? "warn" : "ok"}`}
          >
            {alerts?.length ?? 0} unread
          </span>
        </div>
      </div>

      {error !== null && <div className="error">{error}</div>}

      {alerts === null && <div className="empty">Loading…</div>}

      {alerts !== null && alerts.length === 0 && error === null && (
        <div className="empty">
          {caseId === undefined ? (
            <>
              Nothing changed. Standing watches raise an alert here when
              something appears or disappears — start one from a case&rsquo;s
              Watch tab.
            </>
          ) : (
            <>
              Nothing changed on this case yet. A watch reports nothing on its
              first run by design: the first pass records what is already there,
              so the first real change is not buried under a hundred false ones.
            </>
          )}
        </div>
      )}

      {shown.map((alert) => (
        <div
          className={`alert-row ${alert.changeType === "ADDED" ? "added" : "removed"}`}
          key={alert.id}
        >
          <input
            type="checkbox"
            aria-label={`Select alert ${alert.observationKey}`}
            checked={selected.has(alert.id)}
            onChange={(event) =>
              setSelected((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(alert.id);
                else next.delete(alert.id);
                return next;
              })
            }
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="row" style={{ gap: 7 }}>
              <span
                className={`badge ${alert.changeType === "ADDED" ? "ok" : "deny"}`}
              >
                {alert.changeType === "ADDED" ? "appeared" : "gone"}
              </span>
              <span className="mono alert-key">{alert.observationKey}</span>
            </div>
            <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
              {alert.monitor.name} · watching{" "}
              <span className="mono">{alert.monitor.subjectValue}</span>
              {alert.sourceIds.length > 0 && (
                <> · via {alert.sourceIds.join(", ")}</>
              )}
              {caseId === undefined && alert.caseName !== null && (
                <>
                  {" · "}
                  <Link href={`/cases/${alert.caseId}`}>{alert.caseName}</Link>
                </>
              )}
            </div>
          </div>
          <div className="faint mono alert-when">
            {new Date(alert.createdAt).toLocaleString()}
          </div>
        </div>
      ))}

      {alerts !== null && limit !== undefined && alerts.length > limit && (
        <div className="faint" style={{ fontSize: 12, marginTop: 10 }}>
          {alerts.length - limit} more.
        </div>
      )}
    </div>
  );
}

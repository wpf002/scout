"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { AlertFeed } from "@/components/AlertFeed";
import type { Alert, CaseRecord } from "@/lib/types";
import { Loading } from "@/components/Loading";

interface Health {
  status: string;
  database: string;
  sources: { total: number; keyed: number; keyedSourceIds: string[] };
}

/**
 * The dashboard.
 *
 * Scout was pull-only: you opened a case and went looking. This page inverts
 * that for the one thing that genuinely cannot wait — a change on something
 * already under watch. Everything else here is navigation.
 *
 * What it deliberately does not do is score cases, rank them by "risk", or
 * total up findings across engagements. A number like that would be read as an
 * assessment, and Scout has no basis for one: a case with forty findings and a
 * case with two are not comparable, they are differently scoped.
 */
export default function Dashboard() {
  const [cases, setCases] = useState<CaseRecord[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alertsByCase, setAlertsByCase] = useState<Map<string, number>>(
    new Map(),
  );

  useEffect(() => {
    void (async () => {
      try {
        const [caseList, healthResult] = await Promise.all([
          api.listCases(),
          api.health().catch(() => null),
        ]);
        setCases(caseList.cases);
        setHealth(healthResult);
        setError(null);
      } catch (caught) {
        setCases([]);
        setError(
          caught instanceof ApiError ? caught.message : "Failed to load cases.",
        );
      }
    })();
  }, []);

  const countAlerts = useCallback((alerts: Alert[]) => {
    const counts = new Map<string, number>();
    for (const alert of alerts) {
      counts.set(alert.caseId, (counts.get(alert.caseId) ?? 0) + 1);
    }
    setAlertsByCase(counts);
  }, []);

  const active = (cases ?? []).filter((record) => record.status === "ACTIVE");
  const unscoped = active.filter((record) => record.scopeEntries.length === 0);

  return (
    <>
      <div className="spread" style={{ alignItems: "center" }}>
        <div>
          <span className="eyebrow">Standing watch</span>
          <h1>Watch floor</h1>
          <p className="lede" style={{ marginBottom: 0 }}>
            What changed since you last looked, and which cases it belongs to.
          </p>
        </div>
        <Link href="/cases">
          <button className="primary">New case</button>
        </Link>
      </div>

      {error !== null && (
        <div className="error" style={{ marginTop: 20 }}>
          {error}
        </div>
      )}

      <div className="stat-strip" style={{ marginTop: 22 }}>
        <Stat label="Active cases" value={active.length} />
        <Stat
          label="Cases with scope"
          value={active.length - unscoped.length}
          tone={unscoped.length > 0 ? "warn" : "ok"}
          note={
            unscoped.length > 0
              ? `${unscoped.length} cannot run a scoped source yet`
              : undefined
          }
        />
        <Stat
          label="Sources keyed"
          value={
            health === null
              ? "—"
              : `${health.sources.keyed}/${health.sources.total}`
          }
          note="Unkeyed sources stay inert. Nothing is guessed."
        />
        <Stat
          label="API"
          value={health === null ? "unreachable" : health.status}
          tone={health === null ? "deny" : "ok"}
        />
      </div>

      <div className="dashboard-grid" style={{ marginTop: 20 }}>
        <AlertFeed
          heading="What changed"
          limit={12}
          onLoaded={countAlerts}
        />

        <div className="card">
          <div className="spread" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Cases</h2>
            <Link href="/cases" className="faint" style={{ fontSize: 12 }}>
              all cases →
            </Link>
          </div>

          {cases === null && <Loading what="the case list" />}

          {cases !== null && active.length === 0 && (
            <div className="empty">
              No active cases. <Link href="/cases">Open one</Link> — every
              investigation needs an authorization reference before any scoped
              source will run.
            </div>
          )}

          {active.slice(0, 10).map((record) => {
            const unread = alertsByCase.get(record.id) ?? 0;
            return (
              <div className="case-row" key={record.id}>
                <div style={{ minWidth: 0 }}>
                  <Link href={`/cases/${record.id}`}>{record.name}</Link>
                  <div className="faint mono" style={{ fontSize: 11 }}>
                    {record.authorizationRef}
                  </div>
                </div>
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  {unread > 0 && (
                    <span className="badge warn">{unread} new</span>
                  )}
                  {record.scopeEntries.length === 0 ? (
                    <span className="badge deny" title="No scope — scoped sources will refuse">
                      no scope
                    </span>
                  ) : (
                    <span className="badge ok">
                      {record.scopeEntries.length} scope
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string | number;
  tone?: "ok" | "warn" | "deny";
  note?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div
        className="stat-value"
        style={tone === undefined ? undefined : { color: `var(--${tone})` }}
      >
        {value}
      </div>
      {note !== undefined && <div className="stat-note faint">{note}</div>}
    </div>
  );
}

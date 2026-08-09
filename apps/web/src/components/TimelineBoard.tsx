"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { CaseRecord, TimelineEntry } from "@/lib/types";

type Filter = "all" | "query" | "finding" | "event" | "denied";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "query", label: "Queries" },
  { id: "finding", label: "Findings" },
  { id: "event", label: "Case events" },
  { id: "denied", label: "Refusals" },
];

/**
 * The case as a chronology.
 *
 * Deliberately shows refusals alongside results. A timeline that only recorded
 * what came back would read as if nothing had been attempted out of scope,
 * which is exactly the claim it is least entitled to make — the denials are
 * the part that proves the gate was working.
 */
export function TimelineBoard({ record }: { record: CaseRecord }) {
  const [entries, setEntries] = useState<TimelineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    try {
      const result = await api.timeline(record.id);
      setEntries(result.timeline);
      setError(null);
    } catch (caught) {
      setEntries([]);
      setError(
        caught instanceof ApiError ? caught.message : "Failed to load timeline.",
      );
    }
  }, [record.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = (entries ?? []).filter((entry) =>
    filter === "all"
      ? true
      : filter === "denied"
        ? entry.outcome === "DENIED"
        : entry.kind === filter,
  );

  const denied = (entries ?? []).filter((e) => e.outcome === "DENIED").length;

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Timeline</h2>
        <div className="row">
          {denied > 0 && <span className="badge deny">{denied} refused</span>}
          <span className="badge">{entries?.length ?? 0} events</span>
        </div>
      </div>

      <p className="faint" style={{ fontSize: 12.5, marginTop: 0 }}>
        Every query, finding and case event in the order it happened — refusals
        included. What Scout declined to do is part of the record.
      </p>

      {error !== null && <div className="error">{error}</div>}

      <div className="chip-list" style={{ marginBottom: 14 }}>
        {FILTERS.map((option) => (
          <button
            key={option.id}
            className="tiny"
            style={
              filter === option.id
                ? { borderColor: "var(--accent)", color: "var(--accent)" }
                : undefined
            }
            onClick={() => setFilter(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {entries === null && <div className="empty">Loading…</div>}

      {entries !== null && visible.length === 0 && (
        <div className="empty">Nothing recorded under this filter yet.</div>
      )}

      <ol className="timeline">
        {visible.map((entry, index) => (
          <li
            key={`${entry.at}-${index}`}
            className={`timeline-item ${entry.outcome === "DENIED" ? "denied" : entry.kind}`}
          >
            <div className="timeline-when mono faint">
              {new Date(entry.at).toLocaleString()}
            </div>
            <div className="timeline-body">
              <div className="row" style={{ gap: 7 }}>
                <span className="mono" style={{ fontWeight: 550 }}>
                  {entry.label}
                </span>
                {entry.outcome !== null && entry.outcome !== "ALLOWED" && (
                  <span
                    className={`badge ${entry.outcome === "DENIED" ? "deny" : "warn"}`}
                  >
                    {entry.outcome.toLowerCase()}
                  </span>
                )}
              </div>
              {entry.detail.length > 0 && (
                <div className="faint" style={{ fontSize: 12 }}>
                  {entry.detail}
                </div>
              )}
              <div className="faint" style={{ fontSize: 11 }}>
                {entry.operator}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

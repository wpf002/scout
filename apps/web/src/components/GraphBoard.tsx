"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type {
  CaseGraph,
  CaseRecord,
  EntityKind,
  ResolvedEntity,
  SubjectKind,
} from "@/lib/types";

/**
 * Which entities can become the next query.
 *
 * `cert` and `breach` are absent because neither is a subject: a certificate
 * serial is evidence about a host, and a breach name is a corpus, not someone
 * to look up. Offering a pivot on them would invite a query no source accepts.
 */
const PIVOTABLE: Partial<Record<EntityKind, SubjectKind>> = {
  domain: "domain",
  ip: "ip",
  email: "email",
  username: "username",
  person: "person",
  company: "company",
};

/**
 * Kinds a standing watch can actually take.
 *
 * `person` and `company` are here for sanctions re-screening, which is an
 * ungated dataset lookup against published designation lists. They are *not*
 * here for breach exposure or identity enumeration — the API refuses a monitor
 * on those outright, so an offer here would be a button that always fails.
 */
const WATCHABLE_KINDS: SubjectKind[] = ["domain", "ip", "company", "person"];

export type PivotTarget = "collect" | "watch";

/** Column order — infrastructure on the left, people on the right. */
const KIND_ORDER: EntityKind[] = [
  "domain",
  "ip",
  "cert",
  "email",
  "username",
  "person",
  "company",
  "breach",
];

const KIND_COLOR: Record<EntityKind, string> = {
  domain: "var(--accent)",
  ip: "var(--accent)",
  cert: "var(--ok)",
  email: "var(--scoped)",
  username: "var(--scoped)",
  person: "var(--scoped)",
  company: "var(--warn)",
  breach: "var(--deny)",
};

const NODE_H = 26;
const NODE_W = 172;
const COL_GAP = 62;
const ROW_GAP = 10;

/**
 * The case graph.
 *
 * Laid out deterministically in columns by entity kind rather than with a
 * force simulation: the same case must draw the same picture every time, and
 * a layout that jitters between reloads is one an investigator cannot
 * describe to anyone else.
 *
 * Selecting a node shows the findings and sources behind it. Every edge and
 * every node traces to evidence — a graph is only worth anything if you can
 * ask it "how do you know that".
 */
export function GraphBoard({
  record,
  onPivot,
}: {
  record: CaseRecord;
  /**
   * Continue the investigation from an entity. The graph hands over a subject
   * and nothing else — it never runs the next query itself, because a pivot
   * that executed on click would be a fan-out with extra steps.
   */
  onPivot?: (
    subject: { kind: SubjectKind; value: string },
    target: PivotTarget,
  ) => void;
}) {
  const [graph, setGraph] = useState<CaseGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setGraph(await api.graph(record.id));
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Failed to load the graph.",
      );
    }
  }, [record.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function merge(winningKey: string, losingKey: string, reason: string) {
    setBusy(true);
    try {
      await api.mergeEntities(record.id, { winningKey, losingKey, reason });
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Merge failed.");
    } finally {
      setBusy(false);
    }
  }

  async function dismiss(suggestionId: string) {
    setBusy(true);
    try {
      await api.dismissSuggestion(record.id, suggestionId);
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (graph === null) {
    return (
      <div className="card">
        <h2>Entity graph</h2>
        {error === null ? (
          <div className="empty">Loading…</div>
        ) : (
          <div className="error">{error}</div>
        )}
      </div>
    );
  }

  // Deterministic column layout.
  const columns = KIND_ORDER.map((kind) => ({
    kind,
    entities: graph.entities.filter((e) => e.kind === kind),
  })).filter((column) => column.entities.length > 0);

  const positions = new Map<string, { x: number; y: number }>();
  columns.forEach((column, columnIndex) => {
    column.entities.forEach((entity, rowIndex) => {
      positions.set(entity.key, {
        x: columnIndex * (NODE_W + COL_GAP),
        y: rowIndex * (NODE_H + ROW_GAP) + 26,
      });
    });
  });

  const height =
    Math.max(...columns.map((c) => c.entities.length), 1) * (NODE_H + ROW_GAP) +
    50;
  const width = Math.max(columns.length * (NODE_W + COL_GAP), 320);

  const selectedEntity =
    selected === null
      ? null
      : (graph.entities.find((e) => e.key === selected) ?? null);

  const neighbours =
    selected === null
      ? []
      : graph.links.filter((l) => l.from === selected || l.to === selected);

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Entity graph</h2>
        <div className="row">
          <span className="badge">{graph.totals.entities} entities</span>
          <span
            className={`badge ${graph.totals.corroborated > 0 ? "ok" : "warn"}`}
          >
            {graph.totals.corroborated} corroborated
          </span>
        </div>
      </div>

      {error !== null && <div className="error">{error}</div>}

      <div className="notice">
        <strong>{graph.summary.headline}</strong>
        {graph.summary.paragraphs.map((paragraph, index) => (
          <div key={index} style={{ marginTop: 5 }}>
            {paragraph}
          </div>
        ))}
        <div className="faint" style={{ marginTop: 7, fontSize: 11.5 }}>
          Draft summary, produced by {graph.summary.producedBy}. It is never
          stored as a finding.
        </div>
      </div>

      {graph.entities.length === 0 ? (
        <div className="empty">
          No findings yet, so there is nothing to correlate. Save findings from
          the boards above and they will resolve into entities here.
        </div>
      ) : (
        <div style={{ overflowX: "auto", paddingBottom: 6 }}>
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Entity graph"
            style={{ minWidth: "100%" }}
          >
            {columns.map((column, index) => (
              <text
                key={column.kind}
                x={index * (NODE_W + COL_GAP)}
                y={12}
                fill="var(--text-faint)"
                fontSize={10}
                fontFamily="var(--mono)"
                style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}
              >
                {column.kind}
              </text>
            ))}

            {graph.links.map((link, index) => {
              const from = positions.get(link.from);
              const to = positions.get(link.to);
              if (from === undefined || to === undefined) return null;
              const active =
                selected !== null &&
                (link.from === selected || link.to === selected);
              return (
                <line
                  key={index}
                  x1={from.x + NODE_W}
                  y1={from.y + NODE_H / 2}
                  x2={to.x}
                  y2={to.y + NODE_H / 2}
                  stroke={active ? "var(--accent)" : "var(--border-strong)"}
                  strokeWidth={active ? 1.8 : 1}
                  opacity={selected === null || active ? 0.85 : 0.2}
                >
                  <title>
                    {`${link.relation} — evidenced by ${link.findingIds.length} finding(s) from ${link.sourceIds.join(", ")}`}
                  </title>
                </line>
              );
            })}

            {graph.entities.map((entity) => {
              const position = positions.get(entity.key);
              if (position === undefined) return null;
              const corroborated = entity.sourceIds.length > 1;
              const active = selected === entity.key;
              return (
                <g
                  key={entity.key}
                  transform={`translate(${position.x}, ${position.y})`}
                  onClick={() => setSelected(active ? null : entity.key)}
                  style={{ cursor: "pointer" }}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={4}
                    fill="var(--bg-inset)"
                    stroke={active ? "var(--accent)" : KIND_COLOR[entity.kind]}
                    strokeWidth={active ? 2 : corroborated ? 1.8 : 1}
                    opacity={selected === null || active ? 1 : 0.45}
                  />
                  <text
                    x={9}
                    y={17}
                    fill="var(--text)"
                    fontSize={11}
                    fontFamily="var(--mono)"
                    opacity={selected === null || active ? 1 : 0.45}
                  >
                    {(entity.label ?? entity.value).slice(0, 22)}
                  </text>
                  {corroborated && (
                    <circle
                      cx={NODE_W - 9}
                      cy={NODE_H / 2}
                      r={3}
                      fill="var(--ok)"
                    >
                      <title>{`Corroborated by ${entity.sourceIds.join(", ")}`}</title>
                    </circle>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {selectedEntity !== null && (
        <Evidence
          entity={selectedEntity}
          neighbourCount={neighbours.length}
          {...(onPivot === undefined ? {} : { onPivot })}
        />
      )}

      {graph.suggestions.length > 0 && (
        <>
          <h3 style={{ marginTop: 20 }}>Possible same entity</h3>
          <p className="faint" style={{ fontSize: 12, marginTop: 0 }}>
            Near matches only. Nothing merges until you say so — an automatic
            merge of two similarly-named people would look like a finding.
          </p>
          {graph.suggestions.map((suggestion) => (
            <div className="entry" key={suggestion.id}>
              <div className="spread">
                <div>
                  <div className="entry-title mono" style={{ fontSize: 12.5 }}>
                    {suggestion.left} ↔ {suggestion.right}
                  </div>
                  <div className="entry-desc faint">{suggestion.reason}</div>
                </div>
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <span className="badge">
                    {Math.round(suggestion.confidence * 100)}%
                  </span>
                  <button
                    className="tiny"
                    disabled={busy}
                    onClick={() =>
                      void merge(
                        suggestion.left,
                        suggestion.right,
                        suggestion.reason,
                      )
                    }
                  >
                    Same entity
                  </button>
                  <button
                    className="tiny"
                    disabled={busy}
                    onClick={() => void dismiss(suggestion.id)}
                  >
                    Different
                  </button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Evidence({
  entity,
  neighbourCount,
  onPivot,
}: {
  entity: ResolvedEntity;
  neighbourCount: number;
  onPivot?: (
    subject: { kind: SubjectKind; value: string },
    target: PivotTarget,
  ) => void;
}) {
  const pivotKind = PIVOTABLE[entity.kind];

  return (
    <div className="entry" style={{ marginTop: 12 }}>
      <div className="entry-title mono">{entity.label ?? entity.value}</div>
      <div className="entry-desc">
        <span className="badge" style={{ marginRight: 8 }}>
          {entity.kind}
        </span>
        {entity.sourceIds.length > 1 ? (
          <span className="badge ok">
            corroborated by {entity.sourceIds.length} sources
          </span>
        ) : (
          <span className="badge warn">single source</span>
        )}
      </div>
      <div className="entry-note">
        {/* The answer to "how do you know that". */}
        <div>
          <strong>Reported by:</strong>{" "}
          <span className="mono">{entity.sourceIds.join(", ")}</span>
        </div>
        <div style={{ marginTop: 4 }}>
          <strong>Evidence:</strong> {entity.findingIds.length} finding
          {entity.findingIds.length === 1 ? "" : "s"}, {neighbourCount}{" "}
          relationship{neighbourCount === 1 ? "" : "s"}
        </div>
        <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>
          first seen {new Date(entity.firstSeen).toLocaleString()} · last seen{" "}
          {new Date(entity.lastSeen).toLocaleString()}
        </div>
      </div>

      {onPivot !== undefined && (
        <div className="row" style={{ marginTop: 10 }}>
          {pivotKind === undefined ? (
            <span className="faint" style={{ fontSize: 11.5 }}>
              A {entity.kind} is evidence, not a subject — nothing to pivot to.
            </span>
          ) : (
            <>
              <button
                className="tiny"
                onClick={() =>
                  onPivot({ kind: pivotKind, value: entity.value }, "collect")
                }
              >
                Pivot to this
              </button>
              {WATCHABLE_KINDS.includes(pivotKind) && (
                <button
                  className="tiny"
                  onClick={() =>
                    onPivot({ kind: pivotKind, value: entity.value }, "watch")
                  }
                >
                  Watch it
                </button>
              )}
              <span className="faint" style={{ fontSize: 11.5 }}>
                Fills the next form. Runs nothing.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

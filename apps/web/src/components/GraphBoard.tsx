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

/**
 * Which end of a link is drawn on the left.
 *
 * `subdomain-of` points child → parent, so following edge direction would put
 * the leaves left and the registrable domain right — backwards from how anyone
 * describes it. Layout and drawing both go through here so they cannot
 * disagree; when they did, the columns read correctly and every connector
 * looped backwards around the cards.
 */
function orient(link: { from: string; to: string; relation: string }): [
  string,
  string,
] {
  return link.relation === "subdomain-of"
    ? [link.to, link.from]
    : [link.from, link.to];
}

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

const NODE_H = 44;
const NODE_W = 196;
const COL_GAP = 78;
const ROW_GAP = 14;

/**
 * An orthogonal connector: out of the right edge, across a mid-channel, into
 * the left edge of the target.
 *
 * Straight diagonals cross each other at every angle, and a graph with thirty
 * of them is a haystack. Elbows share vertical channels, so density degrades
 * into something still readable.
 */
function elbow(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;

  // A backwards edge — a cycle the depth pass could not unwind. Route it out
  // to the right of both cards and back, so it goes around them rather than
  // through them.
  if (x2 <= x1) {
    const out = Math.max(x1, to.x + NODE_W) + COL_GAP / 2;
    return [
      `M ${x1} ${y1}`,
      `L ${out} ${y1}`,
      `L ${out} ${y2}`,
      `L ${to.x + NODE_W} ${y2}`,
    ].join(" ");
  }

  const mid = x1 + (x2 - x1) / 2;
  const r = Math.min(8, Math.abs(y2 - y1) / 2, Math.abs(mid - x1));
  if (r < 1) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const down = y2 > y1 ? 1 : -1;
  return [
    `M ${x1} ${y1}`,
    `L ${mid - r} ${y1}`,
    `Q ${mid} ${y1} ${mid} ${y1 + r * down}`,
    `L ${mid} ${y2 - r * down}`,
    `Q ${mid} ${y2} ${mid + r} ${y2}`,
    `L ${x2} ${y2}`,
  ].join(" ");
}

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

  /**
   * Columns are (kind, depth), not kind alone.
   *
   * A case whose entities are all one kind — five hostnames under one domain,
   * which is the common shape — used to stack into a single column with every
   * connector routed straight through the cards. Depth is the distance along
   * same-kind edges, so `acme.example` sits left of its subdomains and the
   * links read left to right like the rest of the graph.
   *
   * Computed by relaxation rather than recursion because the extractor makes no
   * promise the edges are acyclic, and a cycle must not hang the page. The pass
   * count is bounded by the entity count, so the worst case is a chain.
   */
  const depth = new Map<string, number>(
    graph.entities.map((entity) => [entity.key, 0]),
  );
  const kindOf = new Map(graph.entities.map((e) => [e.key, e.kind]));
  for (let pass = 0; pass < graph.entities.length; pass += 1) {
    let moved = false;
    for (const link of graph.links) {
      if (kindOf.get(link.from) !== kindOf.get(link.to)) continue;
      // `subdomain-of` points child → parent, so laying it out in edge
      // direction puts the leaves on the left and the registrable domain on
      // the right — backwards from how anyone describes it. The containing
      // thing goes on the left and the graph fans out rightward from it.
      const [head, tail] = orient(link);
      const from = depth.get(head);
      const to = depth.get(tail);
      if (from === undefined || to === undefined) continue;
      if (to <= from) {
        depth.set(tail, from + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const columns = KIND_ORDER.flatMap((kind) => {
    const ofKind = graph.entities.filter((e) => e.kind === kind);
    const depths = [...new Set(ofKind.map((e) => depth.get(e.key) ?? 0))].sort(
      (a, b) => a - b,
    );
    return depths.map((d, index) => ({
      kind,
      // Only the first column of a kind is labelled; repeating it down the
      // row would read as four different things rather than one deepening.
      label: index === 0 ? kind : "",
      entities: ofKind.filter((e) => (depth.get(e.key) ?? 0) === d),
    }));
  }).filter((column) => column.entities.length > 0);

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
        <div className="graph-canvas">
          <svg
            width={width}
            height={height}
            role="img"
            aria-label="Entity graph"
            style={{ minWidth: "100%" }}
          >
            {columns.map((column, index) => (
              <text
                key={`${column.kind}-${index}`}
                className="graph-col-label"
                x={index * (NODE_W + COL_GAP)}
                y={12}
              >
                {column.label}
              </text>
            ))}

            {graph.links.map((link, index) => {
              const [head, tail] = orient(link);
              const from = positions.get(head);
              const to = positions.get(tail);
              if (from === undefined || to === undefined) return null;
              const active =
                selected !== null &&
                (link.from === selected || link.to === selected);
              return (
                <path
                  key={index}
                  className={`graph-edge ${active ? "active" : selected === null ? "" : "faded"}`}
                  d={elbow(from, to)}
                >
                  <title>
                    {`${link.relation} — evidenced by ${link.findingIds.length} finding(s) from ${link.sourceIds.join(", ")}`}
                  </title>
                </path>
              );
            })}

            {graph.entities.map((entity) => {
              const position = positions.get(entity.key);
              if (position === undefined) return null;
              const sources = entity.sourceIds.length;
              const active = selected === entity.key;
              const dimmed = selected !== null && !active;
              const label = entity.label ?? entity.value;
              return (
                <g
                  key={entity.key}
                  className={`node-card ${active ? "selected" : ""} ${dimmed ? "dimmed" : ""}`}
                  transform={`translate(${position.x}, ${position.y})`}
                  onClick={() => setSelected(active ? null : entity.key)}
                >
                  <rect
                    className="body"
                    width={NODE_W}
                    height={NODE_H}
                    rx={10}
                  />
                  {/* The kind reads as a colour bar rather than a border, so the
                      selection ring stays the only thing that changes on click. */}
                  <rect
                    x={1}
                    y={9}
                    width={3}
                    height={NODE_H - 18}
                    rx={2}
                    fill={KIND_COLOR[entity.kind]}
                  />
                  <text className="kind" x={14} y={17}>
                    {entity.kind}
                  </text>
                  <text className="value" x={14} y={32}>
                    {label.length > 24 ? `${label.slice(0, 23)}…` : label}
                  </text>
                  {sources > 1 && (
                    <g>
                      <circle
                        className="count-bg"
                        cx={NODE_W - 15}
                        cy={15}
                        r={8}
                      />
                      <text
                        className="count-text"
                        x={NODE_W - 15}
                        y={18.5}
                        textAnchor="middle"
                      >
                        {sources}
                      </text>
                      <title>{`Corroborated by ${entity.sourceIds.join(", ")}`}</title>
                    </g>
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

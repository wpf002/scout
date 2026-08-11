"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  runStream,
  type Detection,
  type RunResponse,
  type RunDiff,
  type RunResultRow,
} from "@/lib/api";
import type { Alert, MonitorRecord } from "@/lib/types";
import type { CaseRecord, SubjectKind } from "@/lib/types";
import { flattenObservations, groupRank, type ResultRow } from "@/lib/flatten";
import { buildGraph, TYPE_COLOR } from "@/lib/graph";
import { analyze } from "@/lib/rules";

/** Plain names for the subject kinds. "hash" means nothing to most people. */
const KIND_LABEL: Record<SubjectKind, string> = {
  domain: "Domain",
  ip: "IP Address",
  email: "Email Address",
  username: "Username",
  person: "Person",
  company: "Company",
  hash: "File Hash",
  keyword: "Keyword",
};

const KINDS = Object.keys(KIND_LABEL) as SubjectKind[];

/** Groups worth showing expanded. The rest open on demand. */
const OPEN_BY_DEFAULT = new Set(["Hosts", "Emails", "Breaches", "Sanctions"]);

const PAGE_SIZE = 50;

const STATUS_RANK: Record<RunResultRow["status"], number> = {
  ok: 0,
  blocked: 1,
  error: 2,
  empty: 3,
  deeplink: 4,
  inert: 5,
  "no-adapter": 6,
  // Last, and dimmed. Listed so the roster is always complete, but a source
  // that cannot answer this kind of question is not a gap in coverage.
  "not-applicable": 7,
};

const STATUS_LABEL: Record<RunResultRow["status"], string> = {
  ok: "Results",
  empty: "Nothing Found",
  inert: "Needs API Key",
  blocked: "Not Authorized",
  error: "Unavailable",
  deeplink: "Open",
  "no-adapter": "Coming Soon",
  "not-applicable": "Not For This Type",
};

/**
 * `inert` covers three different situations and they do not read alike: a key
 * that was never set, a tool that is not installed, and a source resting after
 * a quota or an outage. Labelling all three "Needs API Key" tells an operator
 * to go find a key that would change nothing.
 */
const REASON_LABEL: Record<string, string> = {
  "missing-key": "Needs API Key",
  "missing-binary": "Not Installed",
  "cooling-down": "Resting",
};

function statusLabel(row: RunResultRow): string {
  if (row.reason !== null && row.reason in REASON_LABEL) {
    return REASON_LABEL[row.reason] as string;
  }
  return STATUS_LABEL[row.status];
}

export default function Page() {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [caseId, setCaseId] = useState("");
  const [indicator, setIndicator] = useState("");
  const [kind, setKind] = useState<SubjectKind | "">("");
  const [detection, setDetection] = useState<Detection | null>(null);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [running, setRunning] = useState(false);
  /** Sources named at the start, so the rail is complete before any finish. */
  const [expected, setExpected] = useState<number>(0);
  const [live, setLive] = useState<RunResultRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [pages, setPages] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<ResultRow | null>(null);
  const [view, setView] = useState<"table" | "graph">("table");
  const [diff, setDiff] = useState<RunDiff | null>(null);
  const [monitors, setMonitors] = useState<MonitorRecord[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [watching, setWatching] = useState(false);

  useEffect(() => {
    api
      .listCases()
      .then((loaded) => {
        setCases(loaded.cases);
        setCaseId((current) => current || (loaded.cases[0]?.id ?? ""));
      })
      .catch(() => setCases([]));
  }, []);

  const refreshWatches = useCallback(async () => {
    if (caseId === "") return;
    const [loadedMonitors, loadedAlerts] = await Promise.all([
      api.listMonitors(caseId).catch(() => ({ monitors: [] })),
      api.alerts(caseId).catch(() => ({ alerts: [] })),
    ]);
    setMonitors(loadedMonitors.monitors);
    setAlerts(loadedAlerts.alerts);
  }, [caseId]);

  useEffect(() => {
    void refreshWatches();
  }, [refreshWatches]);

  useEffect(() => {
    const term = indicator.trim();
    if (term.length === 0) {
      setDetection(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .detect(term)
        .then((r) => setDetection(r.detection))
        .catch(() => setDetection(null));
    }, 200);
    return () => clearTimeout(timer);
  }, [indicator]);

  const run = useCallback(async () => {
    const term = indicator.trim();
    if (term.length === 0 || caseId === "" || running) return;

    setRunning(true);
    setError(null);
    setResult(null);
    setLive([]);
    setExpected(0);
    setPages({});
    setOpen({});
    setSelected(null);
    setDiff(null);

    // Rows are collected here as well as in state: React batches updates, and
    // the final summary has to be assembled from every row, not from whatever
    // the last render happened to see.
    const collected: RunResultRow[] = [];

    try {
      await runStream(term, caseId, kind === "" ? undefined : kind, (event) => {
        if (event.type === "start") {
          setExpected(event.sources.length);
          setResult({
            subject: event.subject,
            detection: event.detection,
            caseId: event.caseId,
            startedAt: event.startedAt,
            finishedAt: "",
            results: [],
            summary: {
              sourcesConsidered: event.sources.length,
              ran: 0,
              withResults: 0,
              observations: 0,
              inert: 0,
              blocked: 0,
              errored: 0,
            },
          });
          return;
        }

        if (event.type === "result") {
          collected.push(event.row);
          setLive([...collected]);
          return;
        }

        setResult((current) =>
          current === null
            ? current
            : {
                ...current,
                finishedAt: event.finishedAt,
                results: [...collected],
                summary: event.summary,
              },
        );

        // Asked only once the run has been written, so the comparison is
        // against this search rather than the one before it.
        api
          .diff(caseId, term)
          .then(setDiff)
          .catch(() => setDiff(null));
      });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "The search did not complete.",
      );
    } finally {
      setRunning(false);
    }
  }, [indicator, caseId, kind, running]);

  /** During a run the live rows are the truth; afterwards the final set is. */
  const resultRows = useMemo<RunResultRow[]>(
    () => (running ? live : (result?.results.length ? result.results : live)),
    [running, live, result],
  );

  const rows = useMemo<ResultRow[]>(
    () => flattenObservations(resultRows),
    [resultRows],
  );

  const visibleRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return rows;
    return rows.filter(
      (row) =>
        row.value.toLowerCase().includes(needle) ||
        row.detail.toLowerCase().includes(needle) ||
        row.sources.some((s) => s.toLowerCase().includes(needle)),
    );
  }, [rows, filter]);

  const grouped = useMemo(() => {
    const groups = new Map<string, ResultRow[]>();
    for (const row of visibleRows) {
      const existing = groups.get(row.type);
      if (existing === undefined) groups.set(row.type, [row]);
      else existing.push(row);
    }
    return [...groups.entries()].sort(
      (a, b) => groupRank(a[0]) - groupRank(b[0]),
    );
  }, [visibleRows]);

  const sourceRows = useMemo(() => {
    if (resultRows.length === 0) return [];
    return [...resultRows].sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        a.name.localeCompare(b.name),
    );
  }, [resultRows]);

  const insights = useMemo(
    () => (result === null ? [] : analyze(rows, result.subject.value)),
    [rows, result],
  );

  const graph = useMemo(
    () => buildGraph(visibleRows, result?.subject.value ?? ""),
    [visibleRows, result],
  );

  const isOpen = (type: string) => open[type] ?? OPEN_BY_DEFAULT.has(type);

  /**
   * Pivot: take a value out of the results and make it the next search.
   *
   * The move every investigation makes — an address turns up under one domain,
   * and the question becomes what else is on it. Doing that by retyping the
   * value into the box is the tool making you do its work.
   */
  const pivot = (value: string) => {
    setIndicator(value);
    setKind("");
    setSelected(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /**
   * Put this subject under a standing watch.
   *
   * Only the sources that actually ran are offered to the monitor. Watching a
   * source that reported "needs a key" would produce a schedule that can never
   * find anything, and the API refuses any source gated for this subject kind
   * anyway — a person on a timer is standing surveillance, which is the one
   * thing this feature will not do.
   */
  const watchThis = async () => {
    if (result === null || caseId === "" || watching) return;
    const runnable = resultRows
      .filter((r) => r.status === "ok" || r.status === "empty")
      .filter((r) => !r.requiresScope)
      .map((r) => r.sourceId);

    if (runnable.length === 0) return;

    setWatching(true);
    try {
      await api.createMonitor(caseId, {
        name: result.subject.value,
        subject: result.subject,
        sourceIds: runnable,
        intervalMinutes: 1440,
      });
      await refreshWatches();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not create the watch.",
      );
    } finally {
      setWatching(false);
    }
  };

  const dropWatch = async (monitorId: string) => {
    if (caseId === "") return;
    await api.deleteMonitor(caseId, monitorId).catch(() => undefined);
    await refreshWatches();
  };

  const clearAlerts = async () => {
    if (alerts.length === 0) return;
    await api.acknowledgeAlerts(alerts.map((a) => a.id)).catch(() => undefined);
    await refreshWatches();
  };

  /** The case as a client-ready report. The builder already existed. */
  const openReport = (format: "html" | "docx") => {
    if (caseId === "") return;
    window.open(`/api/cases/${caseId}/report?format=${format}`, "_blank");
  };

  /** Everything on screen, as JSON, for a case file or another tool. */
  const exportJson = () => {
    if (result === null) return;
    const payload = {
      subject: result.subject,
      ranAt: result.startedAt,
      summary: result.summary,
      sources: resultRows.map((r) => ({
        source: r.name,
        status: r.status,
        reason: r.reason,
        count: r.count,
        durationMs: r.durationMs,
      })),
      findings: rows.map((r) => ({
        type: r.type,
        value: r.value,
        detail: r.detail,
        sources: r.sources,
        evidence: r.evidence,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `scout-${result.subject.value}-${result.startedAt.slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app">
      <header className="bar">
        <span className="mark">SCOUT</span>
        <label className="field">
          <span>Investigation</span>
          <select
            value={caseId}
            onChange={(event) => setCaseId(event.target.value)}
          >
            {cases.length === 0 ? <option value="">None</option> : null}
            {cases.map((record) => (
              <option key={record.id} value={record.id}>
                {record.name}
              </option>
            ))}
          </select>
        </label>
      </header>

      <section className="query">
        <input
          className="indicator"
          value={indicator}
          onChange={(event) => setIndicator(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run();
          }}
          placeholder="Search a domain, address, email, username or hash"
          spellCheck={false}
          autoFocus
        />
        <select
          className="kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as SubjectKind | "")}
        >
          <option value="">
            {detection === null
              ? "Detect Automatically"
              : `Detected: ${KIND_LABEL[detection.kind]}`}
          </option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <button
          className="run"
          onClick={() => void run()}
          disabled={running || indicator.trim() === "" || caseId === ""}
        >
          {running ? "Searching" : "Search"}
        </button>
        {result !== null && !running ? (
          <button
            className="watch"
            onClick={() => void watchThis()}
            disabled={watching}
            title="Re-run this search daily and alert on anything new"
          >
            {watching ? "Watching" : "Watch"}
          </button>
        ) : null}
      </section>

      {detection !== null &&
      detection.confidence !== "certain" &&
      kind === "" ? (
        <p className="hint">
          Treating this as {KIND_LABEL[detection.kind].toLowerCase()}.
          {detection.alternatives.length > 0 ? (
            <>
              {" "}
              Search as{" "}
              {detection.alternatives.map((alt, index) => (
                <span key={alt}>
                  {index > 0 ? " or " : ""}
                  <button className="link" onClick={() => setKind(alt)}>
                    {KIND_LABEL[alt].toLowerCase()}
                  </button>
                </span>
              ))}{" "}
              instead.
            </>
          ) : null}
        </p>
      ) : null}

      {error !== null ? <p className="error">{error}</p> : null}

      {running || (result !== null && result.finishedAt === "") ? (
        <div className="progress" role="status" aria-live="polite">
          <div className="progress-head">
            <span className="progress-label">
              Searching {expected > 0 ? `${expected} sources` : "sources"}
            </span>
            <span className="progress-count">
              {resultRows.length}
              {expected > 0 ? ` / ${expected}` : ""}
            </span>
          </div>
          <div className="progress-track">
            <div
              className={`progress-fill${expected === 0 ? " indeterminate" : ""}`}
              style={
                expected === 0
                  ? undefined
                  : {
                      width: `${Math.min(100, Math.round((resultRows.length / expected) * 100))}%`,
                    }
              }
            />
          </div>
          {rows.length > 0 ? (
            <p className="progress-note">
              {rows.length} results so far. Slow sources are still working.
            </p>
          ) : null}
        </div>
      ) : null}

      {diff !== null && diff.comparable &&
      (diff.added.count > 0 || diff.removed.count > 0) ? (
        <div className="changed">
          <span className="changed-head">Since Last Search</span>
          {diff.added.count > 0 ? (
            <span className="added">+{diff.added.count} new</span>
          ) : null}
          {diff.removed.count > 0 ? (
            <span className="removed">−{diff.removed.count} gone</span>
          ) : null}
          <span className="changed-list">
            {[...diff.added.values.slice(0, 6)].join(", ")}
            {diff.added.count > 6 ? " …" : ""}
          </span>
        </div>
      ) : null}

      {alerts.length > 0 ? (
        <div className="alerts">
          <span className="alerts-head">
            {alerts.length} Change{alerts.length === 1 ? "" : "s"} Detected
          </span>
          <span className="alerts-list">
            {alerts
              .slice(0, 5)
              .map(
                (a) =>
                  `${a.changeType === "ADDED" ? "+" : "−"} ${a.observationKey}`,
              )
              .join(" · ")}
            {alerts.length > 5 ? " …" : ""}
          </span>
          <button className="link" onClick={() => void clearAlerts()}>
            Acknowledge
          </button>
        </div>
      ) : null}

      {monitors.length > 0 ? (
        <div className="watches">
          <span className="watches-head">Watching</span>
          {monitors.map((monitor) => (
            <span key={monitor.id} className="watch-chip">
              {monitor.subjectValue}
              <button
                onClick={() => void dropWatch(monitor.id)}
                title="Stop watching"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {insights.length > 0 ? (
        <section className="insights">
          <h2>What Stands Out</h2>
          <ul>
            {insights.map((insight) => (
              <li key={insight.id} className={`sev-${insight.severity}`}>
                <span className="sev" />
                <div>
                  <p className="insight-title">{insight.title}</p>
                  <p className="insight-detail">{insight.detail}</p>
                  <p className="insight-evidence">
                    {insight.evidence.join(" · ")}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result === null ? null : (
        <div className={`split${selected !== null ? " with-detail" : ""}`}>
          <aside className="rail">
            <div className="rail-head">
              <h2>Sources</h2>
              <span>
                {/*
                  Counted from the rows in hand, not from the summary — the
                  summary only arrives when the run ends, so this read "0 of 17"
                  for the entire search while sources were plainly reporting.
                */}
                {resultRows.filter((r) => r.status === "ok").length} of{" "}
                {expected > 0 ? expected : result.summary.sourcesConsidered}
              </span>
            </div>
            <ul>
              {sourceRows.map((row) => (
                <li key={row.sourceId} className={`s-${row.status}`}>
                  <span className="dot" />
                  <span className="s-name">{row.name}</span>
                  {row.status === "ok" ? (
                    <>
                      {/* Timing on the slow ones only — noise on the rest. */}
                      {row.durationMs >= 2000 ? (
                        <span className="s-time">
                          {(row.durationMs / 1000).toFixed(1)}s
                        </span>
                      ) : null}
                      <span className="s-count">{row.count}</span>
                    </>
                  ) : row.status === "deeplink" && row.url !== null ? (
                    // Opened in a new tab, never embedded. Ahmia, Torch and
                    // ViewDNS all refuse to be framed, so an in-app panel was
                    // guaranteed to render as a blank white box.
                    <a
                      className="s-open"
                      href={row.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open
                    </a>
                  ) : (
                    <span className="s-status" title={row.message ?? undefined}>
                      {statusLabel(row)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </aside>

          <main className="results">
            <div className="results-head">
              <h2>Results</h2>
              <input
                className="filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter results"
                spellCheck={false}
              />
              <span className="count">{visibleRows.length}</span>
              <div className="views">
                <button
                  className={view === "table" ? "on" : undefined}
                  onClick={() => setView("table")}
                >
                  Table
                </button>
                <button
                  className={view === "graph" ? "on" : undefined}
                  onClick={() => setView("graph")}
                >
                  Graph
                </button>
              </div>
              <button
                className="export"
                onClick={exportJson}
                disabled={rows.length === 0}
              >
                JSON
              </button>
              <button
                className="export"
                onClick={() => openReport("html")}
                disabled={caseId === ""}
              >
                Report
              </button>
              <button
                className="export"
                onClick={() => openReport("docx")}
                disabled={caseId === ""}
              >
                Word
              </button>
            </div>

            {rows.length === 0 ? (
              <p className="empty">Nothing found for {result.subject.value}.</p>
            ) : view === "graph" ? (
              <div className="graph">
                <svg
                  viewBox={graph.viewBox}
                  preserveAspectRatio="xMidYMid meet"
                  role="img"
                  aria-label="Entity graph"
                >
                  {graph.edges.map((edge, index) => {
                    const from = graph.nodes.find((n) => n.id === edge.from);
                    const to = graph.nodes.find((n) => n.id === edge.to);
                    if (from === undefined || to === undefined) return null;
                    return (
                      <line
                        key={`${edge.from}-${edge.to}-${index}`}
                        x1={from.x}
                        y1={from.y}
                        x2={to.x}
                        y2={to.y}
                        className={
                          edge.from === "subject" ? "edge" : "edge strong"
                        }
                      >
                        <title>{edge.reason}</title>
                      </line>
                    );
                  })}

                  {graph.nodes.map((node) => (
                    <g
                      key={node.id}
                      className={`node${selected?.value === node.label ? " picked" : ""}`}
                      onClick={() => setSelected(node.row)}
                    >
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={node.radius}
                        fill={TYPE_COLOR[node.type] ?? "var(--text-faint)"}
                      />
                      {/*
                        Labelled only when corroborated, when it is the subject,
                        or when picked. Labelling all 54 was the clutter — most
                        of them overlapped their neighbour and none could be
                        read. Hovering any node still shows its full value.
                      */}
                      {node.weight > 1 ||
                      node.id === "subject" ||
                      selected?.value === node.row?.value ? (
                        <text x={node.x} y={node.y - node.radius - 5}>
                          {node.label}
                        </text>
                      ) : null}
                      <title>{`${node.type} · ${node.label}`}</title>
                    </g>
                  ))}
                </svg>

                <ul className="legend">
                  {[...new Set(graph.nodes.map((n) => n.type))].map((type) => (
                    <li key={type}>
                      <span
                        className="swatch"
                        style={{
                          background: TYPE_COLOR[type] ?? "var(--text-faint)",
                        }}
                      />
                      {type}
                    </li>
                  ))}
                </ul>

                {graph.omitted.length > 0 ? (
                  <p className="graph-note">
                    Showing the most-corroborated of each type. Not drawn:{" "}
                    {graph.omitted
                      .map((o) => `${o.count} ${o.type.toLowerCase()}`)
                      .join(", ")}
                    . All of it is in the table.
                  </p>
                ) : null}
              </div>
            ) : (
              grouped.map(([type, list]) => {
                const expanded = isOpen(type);
                const page = pages[type] ?? 0;
                const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
                const slice = list.slice(
                  page * PAGE_SIZE,
                  page * PAGE_SIZE + PAGE_SIZE,
                );

                return (
                  <section key={type} className="group">
                    <button
                      className="group-head"
                      onClick={() =>
                        setOpen((current) => ({
                          ...current,
                          [type]: !expanded,
                        }))
                      }
                    >
                      <span className={`caret${expanded ? " down" : ""}`} />
                      <h3>{type}</h3>
                      <span className="group-count">{list.length}</span>
                    </button>

                    {expanded ? (
                      <>
                        <table>
                          <thead>
                            <tr>
                              <th>Value</th>
                              <th>Detail</th>
                              <th>Sources</th>
                            </tr>
                          </thead>
                          <tbody>
                            {slice.map((row) => (
                              <tr
                                key={`${row.type}-${row.value}`}
                                className={
                                  selected?.value === row.value &&
                                  selected?.type === row.type
                                    ? "picked"
                                    : undefined
                                }
                                onClick={() => setSelected(row)}
                              >
                                <td className="v">
                                  {row.url === null ? (
                                    row.value
                                  ) : (
                                    <a
                                      className="cell-link"
                                      href={row.url}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {row.value}
                                    </a>
                                  )}
                                </td>
                                <td className="d">{row.detail}</td>
                                <td className="src">
                                  {row.sources.join(", ")}
                                  {row.occurrences > 1 ? (
                                    <span className="times">
                                      ×{row.occurrences}
                                    </span>
                                  ) : null}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        {totalPages > 1 ? (
                          <div className="pager">
                            <button
                              disabled={page === 0}
                              onClick={() =>
                                setPages((c) => ({ ...c, [type]: page - 1 }))
                              }
                            >
                              Previous
                            </button>
                            <span>
                              {page + 1} of {totalPages}
                            </span>
                            <button
                              disabled={page + 1 >= totalPages}
                              onClick={() =>
                                setPages((c) => ({ ...c, [type]: page + 1 }))
                              }
                            >
                              Next
                            </button>
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </section>
                );
              })
            )}
          </main>

          {selected !== null ? (
            <aside className="detail">
              <div className="detail-head">
                <h2>{selected.type.replace(/s$/, "")}</h2>
                <button className="link" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>

              <div className="detail-body">
                <p className="detail-value">{selected.value}</p>
                {selected.detail.length > 0 ? (
                  <p className="detail-sub">{selected.detail}</p>
                ) : null}

                <div className="detail-actions">
                  <button onClick={() => pivot(selected.value)}>
                    Search This
                  </button>
                  <button
                    onClick={() =>
                      void navigator.clipboard?.writeText(selected.value)
                    }
                  >
                    Copy
                  </button>
                  {selected.url !== null ? (
                    <a href={selected.url} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  ) : null}
                </div>

                {/*
                  A screenshot is the fastest way to know what a host actually
                  is. Rendered inline rather than linked, because the point is
                  to see it without leaving the investigation.
                */}
                {selected.evidence
                  .map((item) => item.observation as { screenshot?: unknown })
                  .filter(
                    (o) =>
                      o !== null &&
                      typeof o === "object" &&
                      typeof o.screenshot === "string",
                  )
                  .slice(0, 1)
                  .map((o) => (
                    <img
                      key={String(o.screenshot)}
                      className="detail-shot"
                      src={String(o.screenshot)}
                      alt="Page screenshot"
                      loading="lazy"
                    />
                  ))}

                <h3>Reported By</h3>
                <ul className="detail-sources">
                  {selected.sources.map((source) => (
                    <li key={source}>{source}</li>
                  ))}
                </ul>

                {/*
                  The raw observation, verbatim. Every summary above is a
                  choice about what mattered; this is what the source actually
                  said, so a finding can be checked rather than trusted.
                */}
                <h3>Raw</h3>
                {selected.evidence.map((item, index) => (
                  <details key={`${item.source}-${index}`} open={index === 0}>
                    <summary>{item.source}</summary>
                    <pre>{JSON.stringify(item.observation, null, 2)}</pre>
                  </details>
                ))}
              </div>
            </aside>
          ) : null}
        </div>
      )}
    </div>
  );
}

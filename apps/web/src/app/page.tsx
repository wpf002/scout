"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  type Detection,
  type RunResponse,
  type RunResultRow,
} from "@/lib/api";
import type { CaseRecord, SubjectKind } from "@/lib/types";
import { flattenObservations, groupRank, type ResultRow } from "@/lib/flatten";

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
};

const STATUS_LABEL: Record<RunResultRow["status"], string> = {
  ok: "Results",
  empty: "Nothing Found",
  inert: "Needs API Key",
  blocked: "Not Authorized",
  error: "Unavailable",
  deeplink: "Open",
  "no-adapter": "Coming Soon",
};

export default function Page() {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [caseId, setCaseId] = useState("");
  const [indicator, setIndicator] = useState("");
  const [kind, setKind] = useState<SubjectKind | "">("");
  const [detection, setDetection] = useState<Detection | null>(null);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [pages, setPages] = useState<Record<string, number>>({});
  const [viewer, setViewer] = useState<{ name: string; url: string } | null>(
    null,
  );

  useEffect(() => {
    api
      .listCases()
      .then((loaded) => {
        setCases(loaded.cases);
        setCaseId((current) => current || (loaded.cases[0]?.id ?? ""));
      })
      .catch(() => setCases([]));
  }, []);

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
    setViewer(null);
    try {
      const response = await api.run(
        term,
        caseId,
        kind === "" ? undefined : kind,
      );
      setResult(response);
      setPages({});
      setOpen({});
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "The run did not complete.",
      );
    } finally {
      setRunning(false);
    }
  }, [indicator, caseId, kind, running]);

  const rows = useMemo<ResultRow[]>(
    () => (result === null ? [] : flattenObservations(result.results)),
    [result],
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
    if (result === null) return [];
    return [...result.results].sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        a.name.localeCompare(b.name),
    );
  }, [result]);

  const isOpen = (type: string) => open[type] ?? OPEN_BY_DEFAULT.has(type);

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

      {result === null ? (
        <p className="empty">
          {running ? "Searching every source." : "Enter something to search."}
        </p>
      ) : (
        <div className="split">
          <aside className="rail">
            <div className="rail-head">
              <h2>Sources</h2>
              <span>
                {result.summary.withResults} of{" "}
                {result.summary.sourcesConsidered}
              </span>
            </div>
            <ul>
              {sourceRows.map((row) => (
                <li key={row.sourceId} className={`s-${row.status}`}>
                  <span className="dot" />
                  <span className="s-name">{row.name}</span>
                  {row.status === "ok" ? (
                    <span className="s-count">{row.count}</span>
                  ) : row.status === "deeplink" && row.url !== null ? (
                    <button
                      className="s-open"
                      onClick={() =>
                        setViewer({ name: row.name, url: row.url as string })
                      }
                    >
                      Open
                    </button>
                  ) : (
                    <span className="s-status" title={row.message ?? undefined}>
                      {STATUS_LABEL[row.status]}
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
            </div>

            {viewer !== null ? (
              <section className="viewer">
                <div className="viewer-head">
                  <h3>{viewer.name}</h3>
                  <a href={viewer.url} target="_blank" rel="noreferrer">
                    Open In New Tab
                  </a>
                  <button className="link" onClick={() => setViewer(null)}>
                    Close
                  </button>
                </div>
                <iframe
                  src={viewer.url}
                  title={viewer.name}
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin allow-forms"
                />
                <p className="viewer-note">
                  Some sites refuse to be embedded. Use Open In New Tab if this
                  stays blank.
                </p>
              </section>
            ) : null}

            {rows.length === 0 ? (
              <p className="empty">Nothing found for {result.subject.value}.</p>
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
                              <tr key={`${row.type}-${row.value}`}>
                                <td className="v">
                                  {row.url === null ? (
                                    row.value
                                  ) : (
                                    <button
                                      className="cell-link"
                                      onClick={() =>
                                        setViewer({
                                          name: row.value,
                                          url: row.url as string,
                                        })
                                      }
                                    >
                                      {row.value}
                                    </button>
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
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  type Detection,
  type RunResponse,
  type RunResultRow,
} from "@/lib/api";
import type { CaseRecord, SubjectKind } from "@/lib/types";
import { flattenObservations, type ResultRow } from "@/lib/flatten";

const SUBJECT_KINDS: SubjectKind[] = [
  "domain",
  "ip",
  "email",
  "username",
  "person",
  "company",
  "hash",
  "keyword",
];

/** Status ordering for the source rail: problems first, quiet ones last. */
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
  empty: "No Results",
  inert: "Not Configured",
  blocked: "Out Of Scope",
  error: "Failed",
  deeplink: "Open Manually",
  "no-adapter": "Not Built",
};

export default function Page() {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [caseId, setCaseId] = useState<string>("");
  const [indicator, setIndicator] = useState("");
  const [kind, setKind] = useState<SubjectKind | "">("");
  const [detection, setDetection] = useState<Detection | null>(null);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .listCases()
      .then((loaded) => {
        setCases(loaded.cases);
        setCaseId((current) => current || (loaded.cases[0]?.id ?? ""));
      })
      .catch(() => setCases([]));
  }, []);

  // Detection previews as you type, so the kind is visible before anything
  // runs — a wrong guess is correctable rather than discovered afterwards.
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

  const activeKind: SubjectKind | null =
    kind !== "" ? kind : (detection?.kind ?? null);

  const run = useCallback(async () => {
    const term = indicator.trim();
    if (term.length === 0 || caseId === "" || running) return;

    setRunning(true);
    setError(null);
    try {
      const response = await api.run(
        term,
        caseId,
        kind === "" ? undefined : kind,
      );
      setResult(response);
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
        row.source.toLowerCase().includes(needle),
    );
  }, [rows, filter]);

  const grouped = useMemo(() => {
    const groups = new Map<string, ResultRow[]>();
    for (const row of visibleRows) {
      const list = groups.get(row.type);
      if (list === undefined) groups.set(row.type, [row]);
      else list.push(row);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [visibleRows]);

  const sourceRows = useMemo(() => {
    if (result === null) return [];
    return [...result.results].sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        a.name.localeCompare(b.name),
    );
  }, [result]);

  const activeCase = cases.find((c) => c.id === caseId) ?? null;

  return (
    <div className="app">
      <header className="bar">
        <span className="mark">SCOUT</span>
        <div className="bar-right">
          <label className="field">
            <span>Case</span>
            <select
              value={caseId}
              onChange={(event) => setCaseId(event.target.value)}
            >
              {cases.length === 0 ? <option value="">No Cases</option> : null}
              {cases.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.name}
                </option>
              ))}
            </select>
          </label>
          {activeCase !== null ? (
            <span className="ref" title="Authorization reference">
              {activeCase.authorizationRef}
            </span>
          ) : null}
        </div>
      </header>

      <section className="query">
        <input
          ref={inputRef}
          className="indicator"
          value={indicator}
          onChange={(event) => setIndicator(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void run();
          }}
          placeholder="Domain, IP, email, username, hash"
          spellCheck={false}
          autoFocus
        />
        <label className="field">
          <span>Type</span>
          <select
            value={kind}
            onChange={(event) =>
              setKind(event.target.value as SubjectKind | "")
            }
          >
            <option value="">
              {detection === null ? "Auto" : `Auto — ${detection.kind}`}
            </option>
            {SUBJECT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <button
          className="run"
          onClick={() => void run()}
          disabled={running || indicator.trim() === "" || caseId === ""}
        >
          {running ? "Running" : "Run"}
        </button>
      </section>

      {detection !== null && detection.confidence !== "certain" && kind === "" ? (
        <p className="hint">
          Read as <strong>{detection.kind}</strong>.{" "}
          {detection.alternatives.length > 0 ? (
            <>
              Also possible:{" "}
              {detection.alternatives.map((alt, index) => (
                <span key={alt}>
                  {index > 0 ? ", " : ""}
                  <button className="link" onClick={() => setKind(alt)}>
                    {alt}
                  </button>
                </span>
              ))}
            </>
          ) : null}
        </p>
      ) : null}

      {error !== null ? <p className="error">{error}</p> : null}

      {result === null ? (
        <p className="empty">
          {running ? "Running." : "Enter an indicator to run every source."}
        </p>
      ) : (
        <div className="split">
          <aside className="rail">
            <div className="rail-head">
              <h2>Sources</h2>
              <span>
                {result.summary.withResults}/{result.summary.sourcesConsidered}
              </span>
            </div>
            <ul>
              {sourceRows.map((row) => (
                <li key={row.sourceId} className={`s-${row.status}`}>
                  <span className="dot" />
                  <span className="s-name">{row.name}</span>
                  {row.status === "ok" ? (
                    <span className="s-count">{row.count}</span>
                  ) : (
                    <span
                      className="s-status"
                      title={row.message ?? undefined}
                    >
                      {row.url !== null && row.status === "deeplink" ? (
                        <a href={row.url} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      ) : (
                        STATUS_LABEL[row.status]
                      )}
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
                placeholder="Filter"
                spellCheck={false}
              />
              <span className="count">
                {visibleRows.length} of {rows.length}
              </span>
            </div>

            {rows.length === 0 ? (
              <p className="empty">
                No source returned data for {result.subject.value}.
              </p>
            ) : (
              grouped.map(([type, list]) => (
                <section key={type} className="group">
                  <h3>
                    {type} <span>{list.length}</span>
                  </h3>
                  <table>
                    <thead>
                      <tr>
                        <th>Value</th>
                        <th>Detail</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((row, index) => (
                        <tr key={`${row.source}-${row.value}-${index}`}>
                          <td className="v">
                            {row.url === null ? (
                              row.value
                            ) : (
                              <a
                                href={row.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {row.value}
                              </a>
                            )}
                          </td>
                          <td className="d">{row.detail}</td>
                          <td className="src">{row.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))
            )}
          </main>
        </div>
      )}
    </div>
  );
}

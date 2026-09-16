"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { KIND_LABEL, SUBJECT_KINDS } from "@/lib/types";
import type {
  DatasetSweepResult,
  InfraSweepResult,
  Subject,
  SweepExclusion,
  SweepSourceReport,
} from "@/lib/types";

/**
 * Global Sweep — every source that is not person-facing, in one action.
 *
 * Batching is allowed here because both endpoints draw only from registries of
 * non-scoped sources, and each filters again on the effective per-subject-kind
 * gate. Anything gated is reported in "Not swept" rather than dropped: a sweep
 * that quietly skipped a refusal would read as "covered everything", and an
 * empty result would look like evidence when it was really a refusal.
 *
 * Person-facing lookups are not here and never will be. Those run one confirmed
 * subject at a time from the OSINT panel.
 */
const KINDS = SUBJECT_KINDS;

export function GlobalSweep() {
  // The sweep runs against one implicit case for the audit trail; it is never
  // chosen here, so only the id is kept.
  const [caseId, setCaseId] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState<Subject["kind"]>("domain");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infra, setInfra] = useState<InfraSweepResult | null>(null);
  const [datasets, setDatasets] = useState<DatasetSweepResult | null>(null);

  useEffect(() => {
    api
      .listCases()
      .then((loaded) => {
        setCaseId((current) => current || (loaded.cases[0]?.id ?? ""));
      })
      .catch(() => {});
  }, []);

  async function sweep() {
    const subject: Subject = { kind, value: value.trim() };
    if (subject.value === "" || caseId === "" || running) return;
    setRunning(true);
    setError(null);
    setInfra(null);
    setDatasets(null);

    // Both run regardless of the other failing — a dead upstream on one side
    // should not hide the other side's results.
    const [infraOut, datasetOut] = await Promise.allSettled([
      api.infraSweep({ caseId, subject }),
      api.datasetSweep({ caseId, subject }),
    ]);

    if (infraOut.status === "fulfilled") setInfra(infraOut.value);
    if (datasetOut.status === "fulfilled") setDatasets(datasetOut.value);

    const failures = [infraOut, datasetOut].filter((r) => r.status === "rejected");
    if (failures.length === 2) {
      const first = failures[0];
      const reason = first?.status === "rejected" ? first.reason : null;
      setError(reason instanceof ApiError ? reason.message : "Sweep failed.");
    }
    setRunning(false);
  }

  const sources: SweepSourceReport[] = [
    ...(infra?.sources ?? []),
    ...(datasets?.sources ?? []),
  ];
  const excluded: SweepExclusion[] = [
    ...(infra?.excluded ?? []),
    ...(datasets?.excluded ?? []),
  ];
  const ran = sources.filter((s) => s.status === "ok").length;
  const observations =
    (infra?.totals.rawObservations ?? 0) + (datasets?.totals.observations ?? 0);
  const swept = infra !== null || datasets !== null;

  return (
    <div className="sweep-panel">
      <div className="sweep-form">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as Subject["kind"])}
          aria-label="Subject kind"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Domain, IP, or other subject"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") void sweep();
          }}
        />
        <button
          type="button"
          onClick={() => void sweep()}
          disabled={running || value.trim() === "" || caseId === ""}
        >
          {running ? "Sweeping…" : "Global Sweep"}
        </button>
      </div>

      {error !== null ? <p className="sweep-error">{error}</p> : null}

      {swept ? (
        <>
          <div className="sweep-totals">
            <span>
              <b>{ran}</b> sources returned
            </span>
            <span>
              <b>{observations}</b> observations
            </span>
            {excluded.length > 0 ? (
              <span className="sweep-excluded-count">
                <b>{excluded.length}</b> not swept
              </span>
            ) : null}
          </div>

          <ul className="sweep-list">
            {sources.map((s) => (
              <li key={s.sourceId}>
                <span className="sw-name">{s.name}</span>
                <span className={`sw-status ${s.status}`} title={s.message ?? undefined}>
                  {s.status === "ok" ? `${s.observationCount}` : (s.reason ?? s.status)}
                </span>
              </li>
            ))}
          </ul>

          {excluded.length > 0 ? (
            <div className="sweep-excluded">
              <h3>Not swept</h3>
              <ul className="sweep-list">
                {excluded.map((x) => (
                  <li key={x.sourceId}>
                    <span className="sw-name">{x.name}</span>
                    <span className="sw-why" title={x.message}>
                      {x.reason === "scope-gated" ? "person-facing" : "kind not accepted"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <p className="panel-empty">Runs every open source at once. People are looked up in OSINT Search.</p>
      )}
    </div>
  );
}

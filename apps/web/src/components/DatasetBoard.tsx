"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { SUBJECT_KINDS } from "@/lib/types";
import type {
  CaseRecord,
  DatasetAdapterInfo,
  DatasetObservation,
  DatasetRunResult,
  Designation,
  ExtractedEntity,
  SubjectKind,
} from "@/lib/types";

/**
 * The datasets board.
 *
 * Runs one source at a time — there is no sweep, because dataset sources are
 * not uniformly non-scoped and a batch path would have to reason about
 * per-subject-kind gating.
 *
 * A designated entity gets a treatment you cannot scroll past. A PEP listing
 * deliberately does not: it says someone holds public office, and dressing
 * that up as a sanction would be a false accusation about a real person.
 */
export function DatasetBoard({
  record,
  onFindingSaved,
}: {
  record: CaseRecord;
  onFindingSaved: () => void;
}) {
  const [adapters, setAdapters] = useState<DatasetAdapterInfo[]>([]);
  const [kind, setKind] = useState<SubjectKind>("person");
  const [value, setValue] = useState("");
  const [results, setResults] = useState<Record<string, DatasetRunResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<DatasetAdapterInfo | null>(null);
  const [tracked, setTracked] = useState<Set<string>>(new Set());

  useEffect(() => {
    api
      .datasetAdapters()
      .then((r) => setAdapters(r.adapters))
      .catch(() => setAdapters([]));
  }, []);

  const gatedFor = (adapter: DatasetAdapterInfo) =>
    adapter.requiresScope || adapter.scopedKinds.includes(kind);

  async function run(adapter: DatasetAdapterInfo) {
    setConfirming(null);
    setRunning(adapter.sourceId);
    setErrors((current) => ({ ...current, [adapter.sourceId]: "" }));
    try {
      const result = await api.runDataset(adapter.sourceId, {
        caseId: record.id,
        subject: { kind, value: value.trim() },
        ...(gatedFor(adapter) ? { confirm: true as const } : {}),
      });
      setResults((current) => ({ ...current, [adapter.sourceId]: result }));
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErrors((current) => ({
          ...current,
          [adapter.sourceId]: caught.isScopeDenial
            ? `Refused (${caught.reason}): ${caught.message}`
            : caught.message,
        }));
      }
    } finally {
      setRunning(null);
    }
  }

  async function track(entity: ExtractedEntity) {
    try {
      await api.addSubject(record.id, {
        kind: entity.kind,
        value: entity.value,
      });
      setTracked((current) =>
        new Set(current).add(`${entity.kind}:${entity.value}`),
      );
      onFindingSaved();
    } catch {
      /* surfaced by the case page on next load */
    }
  }

  async function save(
    sourceId: string,
    observation: DatasetObservation,
    result: DatasetRunResult,
  ) {
    try {
      await api.saveFinding(record.id, {
        sourceId,
        title:
          observation.kind === "sanction-match"
            ? `${observation.caption} — ${observation.datasets.join(", ")}`
            : `${observation.title} (${observation.datasetId})`,
        summary:
          observation.kind === "sanction-match"
            ? observation.sanctioned
              ? `Designated. Topics: ${observation.topics.join(", ")}.`
              : `Listed, not designated. Topics: ${observation.topics.join(", ")}.`
            : (observation.excerpt ?? undefined),
        data: observation,
        queryTerm: value.trim(),
        queryKind: kind,
        ...(result.provenance.queryLogId === undefined
          ? {}
          : { queryLogId: result.provenance.queryLogId }),
      });
      onFindingSaved();
    } catch {
      /* surfaced by the case page on next load */
    }
  }

  const all = Object.entries(results);
  const sanctionedCount = all.reduce(
    (sum, [, r]) => sum + r.totals.sanctioned,
    0,
  );
  const suggestions = all.flatMap(([, r]) => r.suggestedSubjects);

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Datasets board</h2>
        <span className="badge">one source at a time</span>
      </div>

      <p className="faint" style={{ fontSize: 12.5, marginTop: 0 }}>
        Leaks, corporate records and sanctions screening. Some sources are gated
        for some inputs — Intelligence X is free for a domain and scope-gated
        for an email selector.
      </p>

      <div className="row" style={{ alignItems: "flex-end" }}>
        <div style={{ width: 140 }}>
          <label htmlFor="ds-kind">Subject kind</label>
          <select
            id="ds-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as SubjectKind)}
          >
            {SUBJECT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="ds-value">Subject</label>
          <input
            id="ds-value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Jane Designated"
          />
        </div>
      </div>

      {sanctionedCount > 0 && (
        <div className="alert-sanction" style={{ marginTop: 16 }}>
          <div className="headline">
            <span aria-hidden="true">⚠</span>
            {sanctionedCount} sanctioned{" "}
            {sanctionedCount === 1 ? "entity" : "entities"} matched
          </div>
          <div style={{ fontSize: 12.5, marginTop: 5 }}>
            This subject matches an entity that is itself designated. Rows
            marked <em>linked to sanctioned</em>, <em>debarred</em> or{" "}
            <em>PEP</em> are different claims and are not counted here.
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        {adapters.map((adapter) => {
          const gated = gatedFor(adapter);
          const accepts = adapter.accepts.includes(kind);
          return (
            <button
              key={adapter.sourceId}
              disabled={
                !accepts || value.trim().length === 0 || running !== null
              }
              onClick={() => (gated ? setConfirming(adapter) : void run(adapter))}
              title={
                accepts
                  ? undefined
                  : `${adapter.name} does not accept a ${kind} subject`
              }
            >
              {running === adapter.sourceId ? "Running…" : `Run ${adapter.name}`}
              {gated && accepts ? " 🔒" : ""}
            </button>
          );
        })}
      </div>

      {adapters.some((a) => gatedFor(a) && a.accepts.includes(kind)) && (
        <div className="notice" style={{ marginTop: 12 }}>
          🔒 marks a source that is scope-gated for a{" "}
          <span className="mono">{kind}</span> subject. It runs once, for this
          subject only, and the attempt is audited either way.
        </div>
      )}

      {all.map(([sourceId, result]) => (
        <section key={sourceId} style={{ marginTop: 18 }}>
          <div className="tier-head">
            <h2>{result.provenance.sourceName}</h2>
            <span className="blurb">
              {result.totals.observations} result
              {result.totals.observations === 1 ? "" : "s"}
              {result.scopeGated ? " · scope-gated" : ""}
            </span>
          </div>

          {result.status !== "ok" && (
            <div className="entry-note">
              <span className="mono">[{result.reason}] </span>
              {result.message}
            </div>
          )}

          {result.observations.map((observation, index) => (
            <ObservationRow
              key={index}
              observation={observation}
              onSave={() => void save(sourceId, observation, result)}
            />
          ))}
        </section>
      ))}

      {Object.entries(errors).map(([sourceId, message]) =>
        message.length === 0 ? null : (
          <div className="error" key={sourceId} style={{ marginTop: 12 }}>
            <strong>{sourceId}:</strong> {message}
          </div>
        ),
      )}

      {suggestions.length > 0 && (
        <>
          <h3 style={{ marginTop: 22 }}>Suggested subjects</h3>
          <p className="faint" style={{ fontSize: 12, marginTop: 0 }}>
            Pulled out of the results above. Nothing is linked into the case
            until you say so.
          </p>
          <div className="chip-list">
            {suggestions.map((entity) => {
              const key = `${entity.kind}:${entity.value}`;
              return (
                <span className="scope-chip" key={key}>
                  <span className="faint">{entity.kind}</span>
                  {entity.value}
                  <span
                    className="faint"
                    style={{ fontSize: 10 }}
                    title={`${entity.confidence} confidence, from ${entity.fromSourceId}`}
                  >
                    {entity.confidence === "high" ? "●" : "○"}
                  </span>
                  <button
                    className="tiny"
                    disabled={tracked.has(key)}
                    onClick={() => void track(entity)}
                  >
                    {tracked.has(key) ? "Tracked" : "Track"}
                  </button>
                </span>
              );
            })}
          </div>
        </>
      )}

      {confirming !== null && (
        <div className="backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Run a scope-gated lookup</h2>
            <p className="dim" style={{ fontSize: 13 }}>
              {confirming.name} is gated for a{" "}
              <span className="mono">{kind}</span> subject — this input makes it
              a lookup about a person. It runs once, for this subject only.
            </p>
            <div className="confirm-table">
              <div>
                <dt>Source</dt>
                <dd>{confirming.name}</dd>
              </div>
              <div>
                <dt>Subject</dt>
                <dd className="mono">
                  {kind}: {value.trim()}
                </dd>
              </div>
              <div>
                <dt>Authorization</dt>
                <dd className="mono">{record.authorizationRef}</dd>
              </div>
            </div>
            <div className="row">
              <button className="primary" onClick={() => void run(confirming)}>
                Run once
              </button>
              <button onClick={() => setConfirming(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Each designation gets its own words. "Listed" is deliberately never
 * rendered as "clear" — absence of a designation in these datasets is not a
 * statement that the entity is clean.
 */
const DESIGNATION_LABEL: Record<Designation, string> = {
  sanctioned: "sanctioned",
  "linked-to-sanctioned": "linked to sanctioned",
  debarred: "debarred",
  pep: "PEP",
  listed: "listed",
};

const DESIGNATION_STYLE: Record<Designation, string> = {
  sanctioned: "deny",
  "linked-to-sanctioned": "warn",
  debarred: "warn",
  pep: "warn",
  listed: "",
};

const DESIGNATION_ROW: Record<Designation, string> = {
  sanctioned: "sanctioned",
  "linked-to-sanctioned": "pep",
  debarred: "pep",
  pep: "pep",
  listed: "",
};

function ObservationRow({
  observation,
  onSave,
}: {
  observation: DatasetObservation;
  onSave: () => void;
}) {
  if (observation.kind === "sanction-match") {
    return (
      <div className={`entry ${DESIGNATION_ROW[observation.designation]}`}>
        <div className="spread">
          <div>
            <div className="entry-title">
              {observation.caption}{" "}
              <span className="faint" style={{ fontWeight: 400 }}>
                {observation.schema}
              </span>
            </div>
            <div style={{ marginTop: 6 }}>
              {observation.datasets.map((dataset) => (
                <span
                  key={dataset}
                  className={`dataset-chip${observation.sanctioned ? " designating" : ""}`}
                >
                  {dataset}
                </span>
              ))}
            </div>
            <div className="entry-desc faint">
              {observation.topics.join(", ")}
              {observation.countries.length > 0
                ? ` · ${observation.countries.join(", ")}`
                : ""}
              {observation.score !== null
                ? ` · score ${observation.score.toFixed(2)}`
                : ""}
            </div>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <span className={`badge ${DESIGNATION_STYLE[observation.designation]}`}>
              {DESIGNATION_LABEL[observation.designation]}
            </span>
            <button className="tiny" onClick={onSave}>
              + Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="entry">
      <div className="spread">
        <div>
          <div className="entry-title">{observation.title}</div>
          <div className="entry-desc">
            <span className="dataset-chip">{observation.datasetId}</span>
            {observation.date !== null && (
              <span className="faint"> {observation.date}</span>
            )}
          </div>
          {observation.excerpt !== null && (
            <div className="entry-desc faint">{observation.excerpt}</div>
          )}
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          {observation.url !== null && (
            <a href={observation.url} target="_blank" rel="noreferrer noopener">
              <button type="button" className="tiny">
                Open ↗
              </button>
            </a>
          )}
          <button className="tiny" onClick={onSave}>
            + Save
          </button>
        </div>
      </div>
    </div>
  );
}

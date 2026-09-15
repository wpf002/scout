"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api";
import { titleCase } from "@/lib/label";
import { Loading } from "@/components/Loading";
import { ENTITY_KINDS, v2, type Authorization, type Decision, type EntityKind, type ReviewKind, type ReviewPair } from "@/lib/v2";
import { compareFields, describeScore, explainFeatures, handleOf } from "@/lib/review";
import { KIND_COLOUR, stamp } from "@/lib/investigation";
import type { CaseRecord } from "@/lib/types";

/**
 * The review queue.
 *
 * Pairs the model scored inside the review band, one at a time, with the
 * two observations side by side and the model's own evidence column by
 * column. The analyst records a decision with a note; the decision is a
 * pin the next resolution run applies, and this panel says how many pins
 * are waiting and offers that run. Nothing merges on a click here: an
 * adjudication is a record, the run is the act, and both are audited.
 */

const DECISIONS: Array<{ id: Decision; name: string; hint: string }> = [
  { id: "MATCH", name: "Same Entity", hint: "These two observations describe one entity" },
  { id: "NON_MATCH", name: "Different Entities", hint: "These describe two entities, whatever the model thinks" },
  { id: "INDETERMINATE", name: "Can't Tell", hint: "Recorded, so nobody asks again without new evidence" },
];

export function ReviewQueue({ record, onCount, onDecided }: { record: CaseRecord; onCount?: (n: number) => void; onDecided?: () => void }) {
  const caseId = record.id;
  const [authorization, setAuthorization] = useState<Authorization | null | undefined>(undefined);
  const [kinds, setKinds] = useState<ReviewKind[]>([]);
  const [pairs, setPairs] = useState<ReviewPair[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<EntityKind | "">("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const auth = (await v2.authorization(caseId)).authorization;
      setAuthorization(auth);
      if (auth === null) {
        setKinds([]);
        setPairs([]);
        setLoaded(true);
        onCount?.(0);
        return;
      }
      const result = await v2.review(caseId);
      setKinds(result.kinds);
      setPairs(result.pairs);
      onCount?.(result.count);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not read the review queue.");
    } finally {
      setLoaded(true);
    }
  }, [caseId, onCount]);

  useEffect(() => {
    setLoaded(false);
    setSelectedId(null);
    setOutcome(null);
    void load();
  }, [load]);

  const listed = useMemo(() => pairs.filter((p) => (kind === "" ? true : p.kind === kind)), [pairs, kind]);
  const selected = useMemo(() => listed.find((p) => p.decisionId === selectedId) ?? listed[0] ?? null, [listed, selectedId]);
  const mayDecide = authorization?.actionClasses.includes("RESOLVE") ?? false;

  const decide = async (decision: Decision) => {
    if (selected === null || selected.left === null || selected.right === null) return;
    const text = note.trim();
    if (text === "") {
      setError("A decision needs a note: what you saw that the model did not.");
      return;
    }
    setBusy(decision);
    setError(null);
    try {
      await v2.adjudicate(caseId, { leftObservationId: selected.left.id, rightObservationId: selected.right.id, decision, note: text });
      // The pair leaves the queue here, and the kind's waiting count goes
      // up, without a round trip: the server said 201.
      const index = listed.findIndex((p) => p.decisionId === selected.decisionId);
      const next = listed[index + 1] ?? listed[index - 1] ?? null;
      setPairs((current) => current.filter((p) => p.decisionId !== selected.decisionId));
      setKinds((current) => current.map((k) => (k.kind === selected.kind ? { ...k, open: k.open - 1, adjudicatedSinceRun: k.adjudicatedSinceRun + 1 } : k)));
      onCount?.(pairs.length - 1);
      setSelectedId(next?.decisionId ?? null);
      setNote("");
      onDecided?.();
    } catch (caught) {
      setError(caught instanceof ApiError ? (caught.isScopeDenial ? `Refused: ${caught.reason ?? caught.message}` : caught.message) : "The decision was not recorded.");
    } finally {
      setBusy(null);
    }
  };

  const apply = async (target: ReviewKind) => {
    if (target.kind === "UNKNOWN") return;
    setBusy(`apply:${target.kind}`);
    setError(null);
    setOutcome(null);
    try {
      const result = await v2.resolve(caseId, target.kind);
      setOutcome(
        `${titleCase(target.kind)} re-resolved by ${result.modelVersion}: ${result.counts.entities} entities, ${result.counts.pinned} pinned, ${result.counts.review} still to review.`,
      );
      await load();
      onDecided?.();
    } catch (caught) {
      setError(caught instanceof ApiError ? (caught.isScopeDenial ? `Refused: ${caught.reason ?? caught.message}` : caught.message) : "Resolution did not run.");
    } finally {
      setBusy(null);
    }
  };

  if (!loaded || authorization === undefined) return <Loading what="the review queue" />;

  if (authorization === null) {
    return <p className="notice">No authorization on this case. Issue one in the Scope tab.</p>;
  }

  const waiting = kinds.filter((k) => k.adjudicatedSinceRun > 0);

  return (
    <div className="review">
      {error !== null ? <p className="error">{error}</p> : null}
      {outcome !== null ? <p className="notice">{outcome}</p> : null}

      {waiting.length > 0 ? (
        <div className="review-waiting">
          {waiting.map((k) => (
            <div className="review-waiting-row" key={k.kind}>
              <span>
                <b>{k.adjudicatedSinceRun}</b> {k.adjudicatedSinceRun === 1 ? "decision" : "decisions"} on {titleCase(k.kind)} since the last run ({stamp(k.startedAt)}). The next run
                applies {k.adjudicatedSinceRun === 1 ? "it" : "them"} as pins.
              </span>
              <button className="tiny" onClick={() => void apply(k)} disabled={busy !== null || !mayDecide}>
                {busy === `apply:${k.kind}` ? "Running…" : `Re-run ${titleCase(k.kind)} Resolution`}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {!mayDecide ? <p className="notice">This authorization does not include RESOLVE, so decisions can be read here and not recorded.</p> : null}

      <div className="review-split">
        <div className="review-list">
          <div className="review-filters">
            <select value={kind} onChange={(event) => setKind(event.target.value as EntityKind | "")} aria-label="Kind">
              <option value="">All Kinds</option>
              {ENTITY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {titleCase(k)}
                </option>
              ))}
            </select>
            <span className="tiny faint">{listed.length} to review</span>
          </div>
          {listed.length === 0 ? (
            <p className="empty">Nothing to review{kind === "" ? "" : ` for ${titleCase(kind)}`}.</p>
          ) : (
            <ul>
              {listed.map((p) => (
                <li key={p.decisionId}>
                  <button className={`review-row${selected?.decisionId === p.decisionId ? " on" : ""}`} onClick={() => setSelectedId(p.decisionId)}>
                    <i className="kind-dot" style={{ background: p.kind === "UNKNOWN" ? "#676c80" : KIND_COLOUR[p.kind] }} />
                    <span className="review-row-names" title={`${handleOf(p.left)} ↔ ${handleOf(p.right)}`}>
                      {handleOf(p.left)} <span className="faint">↔ {handleOf(p.right)}</span>
                    </span>
                    <span className="mono faint">{p.scoreBp === null ? "—" : `${Math.round(p.scoreBp / 100)}%`}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="review-detail">
          {selected === null ? null : (
            <PairView
              pair={selected}
              note={note}
              onNote={setNote}
              busy={busy}
              mayDecide={mayDecide}
              onDecide={(d) => void decide(d)}
              run={kinds.find((k) => k.runId === selected.runId) ?? null}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PairView({
  pair,
  note,
  onNote,
  busy,
  mayDecide,
  onDecide,
  run,
}: {
  pair: ReviewPair;
  note: string;
  onNote: (value: string) => void;
  busy: string | null;
  mayDecide: boolean;
  onDecide: (decision: Decision) => void;
  run: ReviewKind | null;
}) {
  const fields = compareFields(pair.left, pair.right);
  const evidence = explainFeatures(pair.features);
  const sides: Array<[string, ReviewPair["left"]]> = [
    ["Left", pair.left],
    ["Right", pair.right],
  ];

  return (
    <div>
      <div className="spread">
        <h2>
          {handleOf(pair.left)} <span className="faint">↔</span> {handleOf(pair.right)}
        </h2>
        <span className="badge">{titleCase(pair.kind)}</span>
        <span className="badge warn">Review</span>
      </div>
      <p className="tiny faint">
        Scored {describeScore(pair.scoreBp, pair.features)}
        {run === null ? "" : ` by ${run.modelVersion}`} · blocked on <span className="mono">{pair.blockingKey}</span>
      </p>

      <table className="review-sides">
        <thead>
          <tr>
            <th />
            {sides.map(([label, o]) => (
              <th key={label}>
                {label}
                {o === null ? null : (
                  <span className="faint">
                    {" "}
                    · {o.sourceId} · {stamp(o.observedAt)}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fields.map((row) => (
            <tr key={row.field} className={`agreement-${row.agreement}`}>
              <td>{row.field.replace(/_/g, " ")}</td>
              <td className="mono">{row.left ?? <span className="faint">—</span>}</td>
              <td className="mono">{row.right ?? <span className="faint">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="spread">
        <h3>What The Model Weighed</h3>
        <span className="tiny faint">Largest movement first. ×n argued for a match, ÷n against.</span>
      </div>
      {evidence.length === 0 ? (
        <p className="tiny faint">No comparison detail was stored for this pair.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Column</th>
              <th>Comparison</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {evidence.map((row) => (
              <tr key={row.column}>
                <td>{row.column}</td>
                <td>{row.finding}</td>
                <td className={`mono ${row.direction === "for" ? "ok" : row.direction === "against" ? "deny" : "faint"}`}>{row.weight}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Decision</h3>
      <textarea
        className="review-note"
        value={note}
        onChange={(event) => onNote(event.target.value)}
        placeholder="What you saw that the model did not. Required; it is the record."
        rows={2}
        disabled={!mayDecide || busy !== null}
      />
      <div className="review-actions">
        {DECISIONS.map((d) => (
          <button
            key={d.id}
            className={`review-decide ${d.id.toLowerCase()}`}
            title={d.hint}
            onClick={() => onDecide(d.id)}
            disabled={!mayDecide || busy !== null || pair.left === null || pair.right === null}
          >
            {busy === d.id ? "Recording…" : d.name}
          </button>
        ))}
      </div>
      <p className="tiny faint">A decision outranks the model on the next run and is kept.</p>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError } from "@/lib/api";
import { titleCase } from "@/lib/label";
import { Loading } from "@/components/Loading";
import {
  ENTITY_KINDS,
  v2,
  type AskResult,
  type Authorization,
  type Entity,
  type EntityKind,
  type GraphEdge,
  type GraphNode,
  type Observation,
  type SourceCoverage,
  type TimelineEvent,
} from "@/lib/v2";
import {
  coverageBands,
  describeConfidence,
  earliest,
  EMPTY_LAYER,
  KIND_COLOUR,
  lastPosition,
  mapLayer,
  memberIndex,
  stamp,
  type MapLayer,
} from "@/lib/investigation";
import type { CaseRecord } from "@/lib/types";

/**
 * The investigation console.
 *
 * Read-only by construction: nothing in here can collect, resolve, adjudicate
 * or link. It shows what the graph holds for one case at one moment, and it
 * is honest about the edges of that: which sources were asked and had
 * nothing, which entities hadn't been seen yet, which links can't be placed
 * on the map because an end has no position.
 *
 * The scrubber sets `asOf`, the valid-time clock. Observations are already
 * loaded, so the map and the lists answer a scrub instantly; the graph reads
 * (links, timeline) follow a beat later from the server, which is the only
 * place the two-clock predicate lives. "Only what was known then" pins the
 * knowledge clock to the same instant, the audit reading.
 */

const STATUS_CLASS: Record<Entity["status"], string> = {
  RESOLVED: "ok",
  PROVISIONAL: "warn",
  DISPUTED: "deny",
  UNRESOLVED: "",
};

const BUCKETS = 60;

/**
 * The panel is `min(62vw, 980px)` wide against the right edge (see
 * `.tool-panel.widest`), so a target flown to the centre lands under it.
 * This offset puts the target in the middle of the map that's still visible.
 */
function besidePanel(): [number, number] {
  if (typeof window === "undefined") return [0, 0];
  const panel = Math.min(window.innerWidth * 0.62, 980) + 58;
  return [-panel / 2, 0];
}
const GRAPH_DEBOUNCE_MS = 200;
const DEFAULT_SPAN_MS = 30 * 24 * 60 * 60 * 1000;

interface Pick {
  entityId: string;
  nonce: number;
}

export function Investigation({
  onLayer,
  onFly,
  pick,
}: {
  onLayer: (layer: MapLayer) => void;
  onFly: (place: { lat: number; lon: number; zoom?: number; offset?: [number, number] }) => void;
  /** An entity chosen on the map. The nonce makes re-picking the same one count. */
  pick: Pick | null;
}) {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [caseId, setCaseId] = useState("");
  const [authorization, setAuthorization] = useState<Authorization | null | undefined>(undefined);
  const [observations, setObservations] = useState<Observation[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [sources, setSources] = useState<SourceCoverage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<EntityKind | "">("");
  const [needle, setNeedle] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [range, setRange] = useState<{ from: number; to: number }>(() => {
    const to = Date.now();
    return { from: to - DEFAULT_SPAN_MS, to };
  });
  const [asOfMs, setAsOfMs] = useState(() => Date.now());
  const [strict, setStrict] = useState(false);

  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<AskResult | null>(null);
  const [asking, setAsking] = useState(false);

  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [neighborhood, setNeighborhood] = useState<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[] | null>(null);
  const [graphNote, setGraphNote] = useState<string | null>(null);

  useEffect(() => {
    api
      .listCases()
      .then((result) => {
        setCases(result.cases);
        setCaseId((current) => current || (result.cases[0]?.id ?? ""));
      })
      .catch(() => setCases([]));
  }, []);

  // ── The case: its authorization, then everything it holds ──────────────
  useEffect(() => {
    if (caseId === "") return;
    let cancelled = false;
    setAuthorization(undefined);
    setLoaded(false);
    setError(null);
    setSelectedId(null);
    setAsked(null);
    setObservations([]);
    setEntities([]);
    setSources([]);
    setEdges([]);

    (async () => {
      try {
        const auth = (await v2.authorization(caseId)).authorization;
        if (cancelled) return;
        setAuthorization(auth);
        if (auth === null) {
          setLoaded(true);
          return;
        }
        const [obs, ents] = await Promise.all([v2.observations(caseId), v2.entities(caseId)]);
        if (cancelled) return;
        setObservations(obs.observations);
        setEntities(ents.entities);
        setSources(ents.sources);
        const to = Date.now();
        const from = earliest(obs.observations, new Date(to - DEFAULT_SPAN_MS)).getTime();
        setRange({ from: Math.min(from, to - 60_000), to });
        setAsOfMs(to);
        setLoaded(true);
      } catch (caught) {
        if (cancelled) return;
        setError(describeError(caught));
        setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [caseId]);

  // A point clicked on the map selects its entity here.
  useEffect(() => {
    if (pick !== null) setSelectedId(pick.entityId);
  }, [pick]);

  const asOf = useMemo(() => new Date(asOfMs), [asOfMs]);
  const asOfIso = asOf.toISOString();
  const knownAsIso = strict ? asOfIso : undefined;

  // ── Graph reads at the moment: debounced so a drag is one request ──────
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (caseId === "" || !loaded || authorization === null || authorization === undefined) return;
    if (timer.current !== null) clearTimeout(timer.current);
    let cancelled = false;
    timer.current = setTimeout(() => {
      (async () => {
        try {
          const all = await v2.edges(caseId, asOfIso, knownAsIso);
          if (cancelled) return;
          setEdges(all.edges);
          setGraphNote(null);
          if (selectedId === null) {
            setNeighborhood(null);
            setTimeline(null);
            return;
          }
          const [near, events] = await Promise.all([
            v2.neighbors(caseId, selectedId, asOfIso, knownAsIso),
            v2.timeline(caseId, selectedId, asOfIso, knownAsIso),
          ]);
          if (cancelled) return;
          setNeighborhood({ nodes: near.nodes, edges: near.edges, truncated: near.truncated });
          setTimeline(events.events);
        } catch (caught) {
          if (cancelled) return;
          // A 404 under the strict clock means the entity wasn't known yet,
          // which is an answer, not a failure.
          const notKnown = caught instanceof ApiError && caught.status === 404;
          setNeighborhood(null);
          setTimeline(null);
          setGraphNote(notKnown ? `Not known at ${stamp(asOf)}.` : describeError(caught));
        }
      })();
    }, GRAPH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
    };
  }, [caseId, loaded, authorization, asOfIso, knownAsIso, selectedId, asOf]);

  // ── The map follows the panel ──────────────────────────────────────────
  useEffect(() => {
    onLayer(loaded && authorization ? mapLayer(observations, entities, edges, asOf, selectedId) : EMPTY_LAYER);
  }, [observations, entities, edges, asOf, selectedId, loaded, authorization, onLayer]);

  useEffect(() => () => onLayer(EMPTY_LAYER), [onLayer]);

  // ── Derived views ──────────────────────────────────────────────────────
  const byId = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const observationById = useMemo(() => new Map(observations.map((o) => [o.id, o])), [observations]);

  const firstSeen = useMemo(() => {
    const out = new Map<string, number>();
    for (const e of entities) {
      let min = Number.POSITIVE_INFINITY;
      for (const m of e.members) min = Math.min(min, new Date(m.observedAt).getTime());
      out.set(e.id, min);
    }
    return out;
  }, [entities]);

  const listed = useMemo(() => {
    const q = needle.trim().toLowerCase();
    return entities
      .filter((e) => (kind === "" ? true : e.kind === kind))
      .filter((e) => (q === "" ? true : e.canonicalLabel.toLowerCase().includes(q)))
      .sort((a, b) => a.canonicalLabel.localeCompare(b.canonicalLabel));
  }, [entities, kind, needle]);

  const bands = useMemo(
    () => coverageBands(observations, sources.map((s) => s.sourceId), new Date(range.from), new Date(range.to), BUCKETS),
    [observations, sources, range],
  );
  const bucketAt = Math.min(BUCKETS - 1, Math.floor(((asOfMs - range.from) / Math.max(1, range.to - range.from)) * BUCKETS));
  const stepMs = Math.max(60_000, Math.round((range.to - range.from) / BUCKETS));

  const selected = selectedId === null ? null : (byId.get(selectedId) ?? null);
  const entityOfObservation = useMemo(() => memberIndex(entities), [entities]);

  const submitQuestion = async () => {
    const text = question.trim();
    if (text.length < 3 || caseId === "") return;
    setAsking(true);
    setError(null);
    try {
      setAsked(await v2.ask(caseId, text));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setAsking(false);
    }
  };

  const choose = useCallback(
    (entity: Entity) => {
      setSelectedId(entity.id);
      const at = lastPosition(observations, entity, asOf);
      if (at !== null) onFly({ lat: at.lat, lon: at.lon, zoom: 6, offset: besidePanel() });
    },
    [observations, asOf, onFly],
  );

  const step = (direction: -1 | 1) =>
    setAsOfMs((current) => Math.max(range.from, Math.min(range.to, current + direction * stepMs)));

  if (cases.length === 0) {
    return (
      <div className="casefile investigation">
        <p className="faint">No cases yet. The console reads one case's graph, so a case has to exist first.</p>
      </div>
    );
  }

  return (
    <div className="casefile investigation">
      <header className="casefile-head">
        <label>
          Investigation
          <select value={caseId} onChange={(event) => setCaseId(event.target.value)}>
            {cases.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {titleCase(entry.name)}
              </option>
            ))}
          </select>
        </label>
        {authorization ? (
          <span className={`case-status ${authorization.status === "active" ? "active" : ""}`} title={`Issued by ${authorization.issuedBy}`}>
            {authorization.reference} · {titleCase(authorization.status)} · until {stamp(authorization.validUntil)}
          </span>
        ) : null}
      </header>

      <div className="casefile-body">
        {error !== null ? <p className="error">{error}</p> : null}

        {authorization === undefined || !loaded ? (
          <Loading what="the case graph" />
        ) : authorization === null ? (
          <p className="notice">
            This case has no authorization. The console reads nothing without one; issue it from the case file's Scope tab.
          </p>
        ) : (
          <>
            {/* ── When ── */}
            <div className="scrub">
              <button className="tiny" onClick={() => step(-1)} disabled={asOfMs <= range.from} title="Earlier">
                ◀
              </button>
              <input
                type="range"
                min={range.from}
                max={range.to}
                step={stepMs}
                value={asOfMs}
                onChange={(event) => setAsOfMs(Number(event.target.value))}
                aria-label="As of"
              />
              <button className="tiny" onClick={() => step(1)} disabled={asOfMs >= range.to} title="Later">
                ▶
              </button>
              <span className="mono scrub-when">{stamp(asOf)}</span>
              <button className="tiny" onClick={() => setAsOfMs(range.to)} disabled={asOfMs >= range.to}>
                Now
              </button>
              <label className="tiny scrub-strict" title="Pin the knowledge clock to the same moment: the graph exactly as it was known then, not as it is understood today.">
                <input type="checkbox" checked={strict} onChange={(event) => setStrict(event.target.checked)} />
                Only what was known then
              </label>
            </div>

            <Coverage bands={bands} bucketAt={bucketAt} from={range.from} to={range.to} />

            {/* ── Ask ── */}
            <form
              className="ask"
              onSubmit={(event) => {
                event.preventDefault();
                void submitQuestion();
              }}
            >
              <input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Ask the graph: who is connected to …, path between … and …, who was near … on 2026-08-16, timeline of …, which sources were consulted"
                aria-label="Ask the graph"
                disabled={asking}
                onKeyDown={(event) => {
                  // Enter asks. The form would do this on its own in a
                  // browser; done here so it also holds where key events
                  // are synthesised (tests, automation).
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitQuestion();
                  }
                }}
              />
              <button type="submit" className="tiny" disabled={asking || question.trim().length < 3}>
                {asking ? "Asking…" : "Ask"}
              </button>
            </form>

            <div className="investigation-split">
              {/* ── Who ── */}
              <div className="entity-list">
                <div className="entity-filters">
                  <select value={kind} onChange={(event) => setKind(event.target.value as EntityKind | "")} aria-label="Kind">
                    <option value="">All Kinds</option>
                    {ENTITY_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {titleCase(k)}
                      </option>
                    ))}
                  </select>
                  <input value={needle} onChange={(event) => setNeedle(event.target.value)} placeholder="Find an entity" aria-label="Find an entity" />
                </div>
                <p className="tiny faint">
                  {listed.length} of {entities.length} entities · {observations.length} observations
                </p>
                <ul>
                  {listed.map((e) => {
                    const seen = (firstSeen.get(e.id) ?? 0) <= asOfMs;
                    return (
                      <li key={e.id}>
                        <button
                          className={`entity-row${e.id === selectedId ? " on" : ""}${seen ? "" : " unseen"}`}
                          onClick={() => choose(e)}
                          title={seen ? e.canonicalLabel : `First observed ${stamp(firstSeen.get(e.id) ?? 0)}, after this moment`}
                        >
                          <i className="kind-dot" style={{ background: KIND_COLOUR[e.kind] }} />
                          <span className="entity-label">{titleCase(e.canonicalLabel)}</span>
                          <span className={`badge ${STATUS_CLASS[e.status]}`}>{titleCase(e.status)}</span>
                          <span className="mono faint">{e.members.length}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {/* ── What ── */}
              <div className="entity-view">
                {asked !== null ? (
                  <AnswerView
                    asked={asked}
                    onClose={() => setAsked(null)}
                    observations={observationById}
                    onCite={(observationId) => {
                      const owner = entityOfObservation.get(observationId);
                      if (owner !== undefined) choose(owner);
                    }}
                    onEntity={(entityId) => {
                      const target = byId.get(entityId);
                      if (target !== undefined) choose(target);
                    }}
                  />
                ) : null}
                {selected === null ? (
                  <CaseOverview entities={entities} sources={sources} observations={observations} />
                ) : (
                  <EntityView
                    entity={selected}
                    asOf={asOf}
                    strict={strict}
                    observations={observationById}
                    sources={sources}
                    neighborhood={neighborhood}
                    timeline={timeline}
                    note={graphNote}
                    byId={byId}
                    onChoose={choose}
                    onFly={onFly}
                    position={lastPosition(observations, selected, asOf)}
                  />
                )}
              </div>
            </div>

            <p className="tiny faint investigation-foot">Every read on this page is written to the access log under {authorization.reference}.</p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * An answer, its claims, and what each rests on. A citation is a button
 * when the observation is loaded, and it selects the entity that holds it;
 * a refusal shows its reason and what would lift it.
 */
function AnswerView({
  asked,
  onClose,
  observations,
  onCite,
  onEntity,
}: {
  asked: AskResult;
  onClose: () => void;
  observations: Map<string, Observation>;
  onCite: (observationId: string) => void;
  onEntity: (entityId: string) => void;
}) {
  const { answer } = asked;
  const badge = answer.status === "answered" ? "ok" : answer.status === "insufficient-evidence" ? "warn" : "deny";
  const label = answer.status === "answered" ? "Answered" : answer.status === "insufficient-evidence" ? "Insufficient Evidence" : "Refused";
  return (
    <div className="answer">
      <div className="spread">
        <h2>{asked.question}</h2>
        <span className={`badge ${badge}`}>{label}</span>
        <button className="link tiny answer-close" onClick={onClose} aria-label="Dismiss the answer">
          ×
        </button>
      </div>
      {answer.status !== "answered" ? <p className={answer.status === "refused" ? "error" : "notice"}>{answer.text}</p> : null}
      {answer.refusal?.requires ? (
        <p className="tiny">
          <span className="faint">Requires:</span> {answer.refusal.requires}
        </p>
      ) : null}
      {answer.claims.length > 0 ? (
        <ul className="claims">
          {answer.claims.map((claim, index) => (
            <li key={index} className="claim">
              <span>{claim.text}</span>
              <span className="claim-cites">
                {claim.basis === "collection-log"
                  ? (claim.sourceIds ?? []).map((sourceId) => (
                      <span className="cite faint" key={sourceId} title="From the collection log">
                        {sourceId}
                      </span>
                    ))
                  : claim.observationIds.map((id) => {
                      const o = observations.get(id);
                      const short = id.replace(/^obs_/, "").slice(0, 8);
                      return o === undefined ? (
                        <span className="cite faint" key={id} title={`${id} (not among the loaded observations)`}>
                          {short}
                        </span>
                      ) : (
                        <button className="cite" key={id} onClick={() => onCite(id)} title={`${id} · ${o.sourceId} · ${stamp(o.observedAt)}`}>
                          {short}
                        </button>
                      );
                    })}
                {(claim.entityIds ?? []).length > 0 ? (
                  <button className="cite entity" onClick={() => onEntity((claim.entityIds ?? [])[0] as string)} title="Select the entity">
                    entity
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="tiny faint mono answer-trace">
        {asked.plannedBy === null ? "not planned" : `planned by ${asked.plannedBy}${asked.shape === null ? "" : ` (${asked.shape})`}`}
        {asked.cost === null ? "" : ` · cost ${asked.cost}`}
        {asked.trace.map((t) => ` · ${t.id} ${t.op} ${t.nodes}n ${t.edges}e${t.events > 0 ? ` ${t.events}ev` : ""}${t.sources > 0 ? ` ${t.sources}s` : ""}`).join("")}
        {answer.synthesizedBy === null ? "" : ` · written by ${answer.synthesizedBy}`}
      </p>
    </div>
  );
}

function describeError(caught: unknown): string {
  if (caught instanceof ApiError) return caught.isScopeDenial ? `Refused: ${caught.reason ?? caught.message}` : caught.message;
  return "Could not read the case graph.";
}

/**
 * Where each source had data across the range. An empty band is a source
 * that was asked and had nothing, which is a finding in its own right.
 */
function Coverage({ bands, bucketAt, from, to }: { bands: ReturnType<typeof coverageBands>; bucketAt: number; from: number; to: number }) {
  const max = Math.max(1, ...bands.flatMap((b) => b.counts));
  if (bands.length === 0) return <p className="tiny faint">No sources have been consulted for this authorization.</p>;
  return (
    <div className="coverage" role="table" aria-label="Source coverage">
      <div className="coverage-axis tiny faint mono">
        <span>{stamp(from)}</span>
        <span>{stamp(to)}</span>
      </div>
      {bands.map((b) => (
        <div className="coverage-row" key={b.sourceId} role="row">
          <span className="coverage-name mono" title={b.sourceId}>
            {b.sourceId}
          </span>
          <div className="coverage-bars">
            {b.counts.map((n, i) => (
              <i
                key={i}
                className={`${n > 0 ? "on" : ""}${i > bucketAt ? " future" : ""}`}
                style={n > 0 ? { opacity: 0.35 + (n / max) * 0.65 } : undefined}
                title={n > 0 ? `${n} observation${n === 1 ? "" : "s"}` : undefined}
              />
            ))}
            <i className="coverage-cursor" style={{ left: `${((bucketAt + 0.5) / BUCKETS) * 100}%` }} />
          </div>
          <span className={`coverage-total mono ${b.total === 0 ? "faint" : ""}`}>{b.total === 0 ? "nothing" : b.total}</span>
        </div>
      ))}
    </div>
  );
}

function CaseOverview({ entities, sources, observations }: { entities: Entity[]; sources: SourceCoverage[]; observations: Observation[] }) {
  const byKind = new Map<EntityKind, number>();
  const byStatus = new Map<Entity["status"], number>();
  for (const e of entities) {
    byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
  }
  const positioned = observations.filter((o) => o.position !== null).length;
  const silent = sources.filter((s) => s.observations === 0);
  return (
    <div>
      <div className="spread">
        <h2>Case</h2>
        <span className="faint tiny">Choose an entity, or click a point on the map.</span>
      </div>
      <div className="chip-list">
        {[...byKind.entries()].map(([k, n]) => (
          <span className="scope-chip" key={k}>
            <i className="kind-dot" style={{ background: KIND_COLOUR[k] }} /> {titleCase(k)} <b>{n}</b>
          </span>
        ))}
      </div>
      <div className="chip-list">
        {[...byStatus.entries()].map(([s, n]) => (
          <span className={`badge ${STATUS_CLASS[s]}`} key={s}>
            {titleCase(s)} {n}
          </span>
        ))}
        <span className="badge">{positioned} positioned</span>
      </div>
      <SourcesConsulted sources={sources} contributed={null} />
      {silent.length > 0 ? (
        <p className="notice">
          {silent.length} of {sources.length} sources had nothing for this authorization: {silent.map((s) => s.sourceId).join(", ")}. Absence here is a
          fact about those sources, not about the case.
        </p>
      ) : null}
    </div>
  );
}

function EntityView({
  entity,
  asOf,
  strict,
  observations,
  sources,
  neighborhood,
  timeline,
  note,
  byId,
  onChoose,
  onFly,
  position,
}: {
  entity: Entity;
  asOf: Date;
  strict: boolean;
  observations: Map<string, Observation>;
  sources: SourceCoverage[];
  neighborhood: { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } | null;
  timeline: TimelineEvent[] | null;
  note: string | null;
  byId: Map<string, Entity>;
  onChoose: (entity: Entity) => void;
  onFly: (place: { lat: number; lon: number; zoom?: number; offset?: [number, number] }) => void;
  position: { lon: number; lat: number; at: string } | null;
}) {
  const asOfMs = asOf.getTime();
  const seenMembers = entity.members.filter((m) => new Date(m.observedAt).getTime() <= asOfMs);
  const identifiers = new Map<string, Set<string>>();
  for (const m of seenMembers) {
    const o = observations.get(m.observationId);
    if (o === undefined) continue;
    for (const id of o.identifiers) {
      const set = identifiers.get(id.kind) ?? new Set<string>();
      set.add(id.value);
      identifiers.set(id.kind, set);
    }
  }
  const labelOf = (id: string) => {
    const other = byId.get(id);
    return other === undefined ? id : titleCase(other.canonicalLabel);
  };

  return (
    <div>
      <div className="spread">
        <i className="kind-dot big" style={{ background: KIND_COLOUR[entity.kind] }} />
        <h2>{titleCase(entity.canonicalLabel)}</h2>
        <span className="badge">{titleCase(entity.kind)}</span>
        <span className={`badge ${STATUS_CLASS[entity.status]}`}>{titleCase(entity.status)}</span>
      </div>
      <p className="tiny faint">
        {entity.run === null
          ? "Not yet resolved by a model."
          : `Resolved by ${entity.run.modelVersion} at ${stamp(entity.run.startedAt)}.`}{" "}
        {seenMembers.length} of {entity.members.length} member observations by {stamp(asOf)}
        {strict ? " (as known then)" : ""}.
      </p>

      <div className="spread">
        <h3>Position</h3>
        {position === null ? (
          <span className="faint tiny">No position by this moment.</span>
        ) : (
          <>
            <span className="mono tiny">
              {position.lat.toFixed(4)}, {position.lon.toFixed(4)} · {stamp(position.at)}
            </span>
            <button className="link tiny" onClick={() => onFly({ lat: position.lat, lon: position.lon, zoom: 7, offset: besidePanel() })}>
              Fly there
            </button>
          </>
        )}
      </div>

      <div className="spread">
        <h3>Links</h3>
        {neighborhood?.truncated ? <span className="badge warn">truncated</span> : null}
      </div>
      {note !== null ? (
        <p className="notice">{note}</p>
      ) : neighborhood === null ? (
        <p className="tiny faint">Reading…</p>
      ) : neighborhood.edges.length === 0 ? (
        <p className="tiny faint">No links held at this moment.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Relation</th>
              <th>With</th>
              <th>Confidence</th>
              <th>Held</th>
            </tr>
          </thead>
          <tbody>
            {neighborhood.edges.map((e) => {
              const otherId = e.fromEntityId === entity.id ? e.toEntityId : e.fromEntityId;
              const other = byId.get(otherId);
              return (
                <tr key={e.id}>
                  <td className="mono">{titleCase(e.relation.replace(/_/g, " "))}</td>
                  <td>
                    {other === undefined ? (
                      <span className="mono">{labelOf(otherId)}</span>
                    ) : (
                      <button className="link" onClick={() => onChoose(other)}>
                        {labelOf(otherId)}
                      </button>
                    )}
                  </td>
                  <td className="mono">{describeConfidence(e.confidenceBp, e.basis)}</td>
                  <td className="mono faint">
                    {stamp(e.validFrom)} → {e.validUntil === null ? "open" : stamp(e.validUntil)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3>Identifiers</h3>
      {identifiers.size === 0 ? (
        <p className="tiny faint">None among the observations seen by this moment.</p>
      ) : (
        <div className="chip-list">
          {[...identifiers.entries()].flatMap(([k, values]) =>
            [...values].slice(0, 6).map((value) => (
              <span className="scope-chip" key={`${k}:${value}`} title={k}>
                <span className="faint">{k.toLowerCase().replace(/_/g, " ")}</span> {value}
              </span>
            )),
          )}
        </div>
      )}

      <h3>Members</h3>
      <table>
        <thead>
          <tr>
            <th>Observed</th>
            <th>Source</th>
            <th>Score</th>
            <th>Method</th>
            <th>Added By</th>
          </tr>
        </thead>
        <tbody>
          {[...entity.members]
            .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
            .map((m) => {
              const future = new Date(m.observedAt).getTime() > asOfMs;
              return (
                <tr key={m.observationId} className={future ? "unseen" : undefined} title={future ? "Observed after this moment" : undefined}>
                  <td className="mono">{stamp(m.observedAt)}</td>
                  <td className="mono">{m.sourceId}</td>
                  <td className="mono">{describeConfidence(m.scoreBp, null)}</td>
                  <td className="mono faint">{m.method}</td>
                  <td>{titleCase(m.addedBy)}</td>
                </tr>
              );
            })}
        </tbody>
      </table>

      <SourcesConsulted sources={sources} contributed={new Set(entity.sourceIds)} />

      <h3>Timeline</h3>
      {timeline === null ? (
        <p className="tiny faint">{note === null ? "Reading…" : ""}</p>
      ) : timeline.length === 0 ? (
        <p className="tiny faint">Nothing by this moment.</p>
      ) : (
        <ul className="timeline">
          {timeline.map((event, index) => (
            <li key={`${event.at}:${index}`} className="timeline-row">
              <span className="timeline-when mono faint">{stamp(event.at)}</span>
              <span className="timeline-body">
                {event.otherEntityId !== undefined ? event.detail.replace(/with .+ (began|ended)$/, (_, verb: string) => `with ${labelOf(event.otherEntityId ?? "")} ${verb}`) : event.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The honesty panel. Every source consulted under the authorization, with
 * what it gave: for the case, or for one entity. "None" is printed, never
 * omitted; a source that said nothing is the thing an investigator most
 * needs to know was asked.
 */
function SourcesConsulted({ sources, contributed }: { sources: SourceCoverage[]; contributed: Set<string> | null }) {
  const silent = sources.filter((s) => (contributed === null ? s.observations === 0 : !contributed.has(s.sourceId)));
  return (
    <>
      <div className="spread">
        <h3>Sources Consulted</h3>
        <span className="faint tiny">
          {sources.length - silent.length} of {sources.length} had something{contributed === null ? "" : " on this entity"}.
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Observations</th>
            <th>Last Observed</th>
            {contributed !== null ? <th>This Entity</th> : null}
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => {
            const has = contributed === null ? s.observations > 0 : contributed.has(s.sourceId);
            return (
              <tr key={s.sourceId} className={has ? undefined : "unseen"}>
                <td className="mono">{s.sourceId}</td>
                <td className="mono">{s.observations === 0 ? "none" : s.observations}</td>
                <td className="mono faint">{s.lastObservedAt === null ? "—" : stamp(s.lastObservedAt)}</td>
                {contributed !== null ? <td className={has ? "ok" : "faint"}>{has ? "Contributed" : "Nothing"}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

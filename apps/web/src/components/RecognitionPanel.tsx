"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api";
import { titleCase } from "@/lib/label";
import { Loading } from "@/components/Loading";
import { stamp } from "@/lib/investigation";
import {
  LAWFUL_BASES,
  MEDIA_ORIGINS,
  v2,
  type CompareOutcome,
  type Entity,
  type GalleryDetail,
  type GallerySummary,
  type Modality,
} from "@/lib/v2";
import type { CaseRecord } from "@/lib/types";

/**
 * The custodian's screen for recognition.
 *
 * Three acts, each the most legally loaded click in the product, each
 * behind the gates the API enforces and the form makes visible: a gallery
 * is created with its lawful basis, document and review date stated; an
 * identity is enrolled from media whose origin and document are stated
 * (scraped or open-web media cannot be chosen here and is refused on the
 * server if sent); a probe is compared against one gallery and the answer
 * is the decision with its candidates and distances, INDETERMINATE
 * included. The media is read in the browser, sent once, and kept nowhere.
 * Every act is an audit event; every comparison is a permanent row.
 */

const DECISION_CLASS = { MATCH: "ok", NO_MATCH: "", INDETERMINATE: "warn" } as const;
const inAYear = () => new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString().slice(0, 10);

function readFile(file: File): Promise<{ b64: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve({ b64: comma === -1 ? result : result.slice(comma + 1), contentType: file.type || "application/octet-stream" });
    };
    reader.readAsDataURL(file);
  });
}

const describe = (caught: unknown, fallback: string) => (caught instanceof ApiError ? caught.message : fallback);

export function RecognitionPanel({ record, onActed }: { record: CaseRecord; onActed?: () => void }) {
  const caseId = record.id;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [galleries, setGalleries] = useState<GallerySummary[]>([]);
  const [galleryId, setGalleryId] = useState<string>("");
  const [detail, setDetail] = useState<GalleryDetail | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [outcome, setOutcome] = useState<CompareOutcome | null>(null);

  const loadGalleries = useCallback(async () => {
    try {
      const listed = await v2.galleries();
      setEnabled(listed.enabled);
      setGalleries(listed.galleries);
      setGalleryId((current) => current || (listed.galleries[0]?.id ?? ""));
    } catch (caught) {
      setError(describe(caught, "Could not list galleries."));
    }
  }, []);

  const loadDetail = useCallback(async () => {
    if (galleryId === "") {
      setDetail(null);
      return;
    }
    try {
      setDetail(await v2.gallery(galleryId, caseId));
    } catch (caught) {
      setDetail(null);
      setError(describe(caught, "Could not read the gallery."));
    }
  }, [galleryId, caseId]);

  useEffect(() => {
    void loadGalleries();
    v2.entities(caseId)
      .then((r) => setEntities(r.entities))
      .catch(() => setEntities([]));
  }, [loadGalleries, caseId]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const refresh = useCallback(async () => {
    await loadGalleries();
    await loadDetail();
    onActed?.();
  }, [loadGalleries, loadDetail, onActed]);

  const selected = useMemo(() => galleries.find((g) => g.id === galleryId) ?? null, [galleries, galleryId]);

  if (enabled === null && galleries.length === 0 && error === null) return <Loading what="the galleries" />;

  return (
    <div className="recognition">
      {enabled === false ? (
        <p className="notice">
          Recognition is <b>off</b>. Galleries can be built; enrollment and comparison are refused.
        </p>
      ) : null}
      {error !== null ? <p className="error">{error}</p> : null}
      {notice !== null ? <p className="notice">{notice}</p> : null}

      <div className="spread">
        <h2>Galleries</h2>
        <span className="faint tiny">1:N comparison runs against one of these and nothing else.</span>
        <button className="tiny recognition-new" onClick={() => setCreating((c) => !c)}>
          {creating ? "Cancel" : "New Gallery"}
        </button>
      </div>

      {creating ? (
        <GalleryForm
          busy={busy === "gallery"}
          onSubmit={async (body) => {
            setBusy("gallery");
            setError(null);
            try {
              const created = await v2.createGallery(body);
              setCreating(false);
              setGalleryId(created.id);
              setNotice(`Gallery "${created.name}" created under ${titleCase(created.lawfulBasis.replace(/_/g, " "))}, document ${created.lawfulBasisDocumentRef}, review due ${stamp(created.reviewDueAt)}.`);
              await refresh();
            } catch (caught) {
              setError(describe(caught, "The gallery was not created."));
            } finally {
              setBusy(null);
            }
          }}
        />
      ) : null}

      {galleries.length === 0 ? (
        <p className="empty">No galleries. A comparison needs one, with its lawful basis on record.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Gallery</th>
              <th>Basis</th>
              <th>Document</th>
              <th>Review Due</th>
              <th>Enrolled</th>
              <th>Compared</th>
            </tr>
          </thead>
          <tbody>
            {galleries.map((g) => (
              <tr key={g.id} className={g.id === galleryId ? "on" : undefined} onClick={() => setGalleryId(g.id)} style={{ cursor: "pointer" }}>
                <td>
                  {g.name} <span className="faint tiny">· {g.custodianOrg}</span>
                </td>
                <td>{titleCase(g.lawfulBasis.replace(/_/g, " "))}</td>
                <td className="mono">{g.lawfulBasisDocumentRef}</td>
                <td className={`mono ${g.reviewOverdue ? "deny" : ""}`}>
                  {stamp(g.reviewDueAt)}
                  {g.reviewOverdue ? " · overdue" : ""}
                </td>
                <td className="mono">{g.enrollments}</td>
                <td className="mono">{g.comparisons}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected !== null && detail !== null ? (
        <>
          <div className="spread">
            <h2>{selected.name}</h2>
            <span className="badge">{titleCase(selected.lawfulBasis.replace(/_/g, " "))}</span>
            {selected.reviewOverdue ? <span className="badge deny">Review Overdue</span> : <span className="badge ok">Review {stamp(selected.reviewDueAt)}</span>}
          </div>
          <p className="tiny faint">{selected.purpose}</p>

          <h3>Enrollments</h3>
          {detail.enrollments.length === 0 ? (
            <p className="tiny faint">Nobody enrolled. Comparison would be INDETERMINATE.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Identity</th>
                  <th>Modality</th>
                  <th>Document</th>
                  <th>Enrolled</th>
                  <th>Expires</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {detail.enrollments.map((e) => (
                  <tr key={e.id} className={e.active ? undefined : "unseen"}>
                    <td>{e.label === null ? <span className="mono">{e.entityId}</span> : titleCase(e.label)}</td>
                    <td>{titleCase(e.modality)}</td>
                    <td className="mono">{e.lawfulBasisDocumentRef}</td>
                    <td className="mono faint">{stamp(e.enrolledAt)}</td>
                    <td className="mono faint">{stamp(e.expiresAt)}</td>
                    <td>{e.revokedAt !== null ? <span className="badge deny">Revoked</span> : e.active ? <span className="badge ok">Active</span> : <span className="badge warn">Expired</span>}</td>
                    <td>
                      {e.revokedAt === null ? (
                        <button
                          className="tiny"
                          disabled={busy !== null}
                          onClick={async () => {
                            const reason = window.prompt("Reason for revoking this enrollment (recorded):");
                            if (reason === null || reason.trim() === "") return;
                            setBusy(`revoke:${e.id}`);
                            try {
                              await v2.revokeEnrollment(selected.id, e.id, reason.trim());
                              await refresh();
                            } catch (caught) {
                              setError(describe(caught, "The enrollment was not revoked."));
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="recognition-forms">
            <EnrollForm
              disabled={enabled !== true || selected.reviewOverdue}
              busy={busy === "enroll"}
              entities={entities}
              onSubmit={async (body) => {
                setBusy("enroll");
                setError(null);
                try {
                  const result = await v2.enroll(selected.id, { caseId, ...body });
                  setNotice(`Enrolled as ${result.model} (${result.dims} dims). Media hash ${result.mediaHash.slice(0, 12)}…; the media itself was not kept.`);
                  await refresh();
                } catch (caught) {
                  setError(describe(caught, "Nothing was enrolled."));
                } finally {
                  setBusy(null);
                }
              }}
            />
            <CompareForm
              disabled={enabled !== true || selected.reviewOverdue}
              busy={busy === "compare"}
              onSubmit={async (body) => {
                setBusy("compare");
                setError(null);
                setOutcome(null);
                try {
                  setOutcome(await v2.compare({ caseId, galleryId: selected.id, ...body }));
                  await refresh();
                } catch (caught) {
                  setError(describe(caught, "Nothing was compared."));
                } finally {
                  setBusy(null);
                }
              }}
            />
          </div>

          {outcome !== null ? <Outcome outcome={outcome} /> : null}

          <h3>Comparison Log</h3>
          {detail.comparisons.length === 0 ? (
            <p className="tiny faint">No comparisons yet. Every one is kept.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>By</th>
                  <th>Modality</th>
                  <th>Decision</th>
                  <th>Best Candidate</th>
                  <th>Probe</th>
                </tr>
              </thead>
              <tbody>
                {detail.comparisons.map((c) => {
                  const best = c.topMatches[0];
                  return (
                    <tr key={c.id}>
                      <td className="mono">{stamp(c.requestedAt)}</td>
                      <td>{c.requestedBy}</td>
                      <td>{titleCase(c.modality)}</td>
                      <td>
                        <span className={`badge ${DECISION_CLASS[c.decision]}`}>{titleCase(c.decision.replace(/_/g, " "))}</span>
                      </td>
                      <td className="mono">{best === undefined ? "—" : `${best.label === null ? best.entityId ?? best.enrollmentId : titleCase(best.label)} · ${best.distanceBp.toLocaleString("en-US").replace(/,/g, " ")} bp`}</td>
                      <td className="mono faint" title={c.probeHash}>
                        {c.probeHash.slice(0, 12)}…
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </div>
  );
}

function GalleryForm({ busy, onSubmit }: { busy: boolean; onSubmit: (body: Parameters<typeof v2.createGallery>[0]) => void }) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [custodianOrg, setCustodianOrg] = useState("");
  const [lawfulBasis, setLawfulBasis] = useState<(typeof LAWFUL_BASES)[number]>("CONSENT");
  const [documentRef, setDocumentRef] = useState("");
  const [reviewDueAt, setReviewDueAt] = useState(inAYear());
  const [confirmed, setConfirmed] = useState(false);
  const ready = name.trim() !== "" && purpose.trim().length >= 8 && custodianOrg.trim() !== "" && documentRef.trim() !== "" && confirmed && !busy;
  return (
    <form
      className="recognition-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onSubmit({ name: name.trim(), purpose: purpose.trim(), custodianOrg: custodianOrg.trim(), lawfulBasis, lawfulBasisDocumentRef: documentRef.trim(), reviewDueAt: new Date(`${reviewDueAt}T00:00:00Z`).toISOString(), confirmLawfulBasis: true });
      }}
    >
      <div className="row">
        <div style={{ flex: 1, minWidth: 160 }}>
          <label htmlFor="gal-name">Name</label>
          <input id="gal-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Site staff" />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label htmlFor="gal-org">Custodian</label>
          <input id="gal-org" value={custodianOrg} onChange={(e) => setCustodianOrg(e.target.value)} placeholder="Customer Security" />
        </div>
        <div style={{ width: 170 }}>
          <label htmlFor="gal-basis">Lawful Basis</label>
          <select id="gal-basis" value={lawfulBasis} onChange={(e) => setLawfulBasis(e.target.value as (typeof LAWFUL_BASES)[number])}>
            {LAWFUL_BASES.map((b) => (
              <option key={b} value={b}>
                {titleCase(b.replace(/_/g, " "))}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="row">
        <div style={{ flex: 2, minWidth: 220 }}>
          <label htmlFor="gal-purpose">Purpose</label>
          <input id="gal-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Why these identities may be compared, in one sentence" />
        </div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <label htmlFor="gal-doc">Basis Document Ref</label>
          <input id="gal-doc" value={documentRef} onChange={(e) => setDocumentRef(e.target.value)} placeholder="HR-POLICY-7" />
        </div>
        <div style={{ width: 150 }}>
          <label htmlFor="gal-review">Review Due</label>
          <input id="gal-review" type="date" value={reviewDueAt} onChange={(e) => setReviewDueAt(e.target.value)} />
        </div>
      </div>
      <div className="row">
        <label className="recognition-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          The lawful basis named above is on file under the document reference given. This statement is recorded with my name.
        </label>
        <button type="submit" className="primary" disabled={!ready}>
          {busy ? "Creating…" : "Create Gallery"}
        </button>
      </div>
    </form>
  );
}

function EnrollForm({
  disabled,
  busy,
  entities,
  onSubmit,
}: {
  disabled: boolean;
  busy: boolean;
  entities: Entity[];
  onSubmit: (body: { entityId: string; modality: Modality; mediaB64: string; contentType: string; origin: string; lawfulBasisDocumentRef: string; expiresAt: string }) => void;
}) {
  const [entityId, setEntityId] = useState("");
  const [modality, setModality] = useState<Modality>("FACE");
  const [origin, setOrigin] = useState<(typeof MEDIA_ORIGINS)[number]>("consented-upload");
  const [documentRef, setDocumentRef] = useState("");
  const [expiresAt, setExpiresAt] = useState(inAYear());
  const [file, setFile] = useState<File | null>(null);
  const people = useMemo(() => [...entities].sort((a, b) => a.canonicalLabel.localeCompare(b.canonicalLabel)), [entities]);
  const ready = !disabled && !busy && entityId !== "" && documentRef.trim() !== "" && file !== null;
  return (
    <form
      className="recognition-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready || file === null) return;
        const media = await readFile(file);
        onSubmit({ entityId, modality, mediaB64: media.b64, contentType: media.contentType, origin, lawfulBasisDocumentRef: documentRef.trim(), expiresAt: new Date(`${expiresAt}T00:00:00Z`).toISOString() });
      }}
    >
      <h3>Enroll an Identity</h3>
      <div className="row">
        <div style={{ flex: 1, minWidth: 180 }}>
          <label htmlFor="enr-entity">Entity (from this case)</label>
          <select id="enr-entity" value={entityId} onChange={(e) => setEntityId(e.target.value)} disabled={disabled}>
            <option value="">Choose…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {titleCase(p.canonicalLabel)} · {titleCase(p.kind)}
              </option>
            ))}
          </select>
        </div>
        <div style={{ width: 110 }}>
          <label htmlFor="enr-mod">Modality</label>
          <select id="enr-mod" value={modality} onChange={(e) => setModality(e.target.value as Modality)} disabled={disabled}>
            <option value="FACE">Face</option>
            <option value="VOICE">Voice</option>
          </select>
        </div>
        <div style={{ width: 180 }}>
          <label htmlFor="enr-origin">Media Origin</label>
          <select id="enr-origin" value={origin} onChange={(e) => setOrigin(e.target.value as (typeof MEDIA_ORIGINS)[number])} disabled={disabled}>
            {MEDIA_ORIGINS.map((o) => (
              <option key={o} value={o}>
                {titleCase(o.replace(/-/g, " "))}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="row">
        <div style={{ flex: 1, minWidth: 160 }}>
          <label htmlFor="enr-doc">Basis Document Ref</label>
          <input id="enr-doc" value={documentRef} onChange={(e) => setDocumentRef(e.target.value)} placeholder="CONSENT-FORM-2026-041" disabled={disabled} />
        </div>
        <div style={{ width: 150 }}>
          <label htmlFor="enr-exp">Expires</label>
          <input id="enr-exp" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} disabled={disabled} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="enr-file">{modality === "FACE" ? "Face image" : "Voice recording"}</label>
          <input id="enr-file" type="file" accept={modality === "FACE" ? "image/*" : "audio/*"} onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={disabled} />
        </div>
        <button type="submit" className="primary" disabled={!ready}>
          {busy ? "Enrolling…" : "Enroll"}
        </button>
      </div>
      <p className="tiny faint">Scraped media is refused. The file is not kept; its hash is logged.</p>
    </form>
  );
}

function CompareForm({ disabled, busy, onSubmit }: { disabled: boolean; busy: boolean; onSubmit: (body: { modality: Modality; mediaB64: string; contentType: string; topN: number; diarize: boolean }) => void }) {
  const [modality, setModality] = useState<Modality>("FACE");
  const [topN, setTopN] = useState(5);
  const [diarize, setDiarize] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const ready = !disabled && !busy && file !== null;
  return (
    <form
      className="recognition-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready || file === null) return;
        const media = await readFile(file);
        onSubmit({ modality, mediaB64: media.b64, contentType: media.contentType, topN, diarize: modality === "VOICE" && diarize });
      }}
    >
      <h3>Compare a Probe</h3>
      <div className="row">
        <div style={{ width: 110 }}>
          <label htmlFor="cmp-mod">Modality</label>
          <select id="cmp-mod" value={modality} onChange={(e) => setModality(e.target.value as Modality)} disabled={disabled}>
            <option value="FACE">Face</option>
            <option value="VOICE">Voice</option>
          </select>
        </div>
        <div style={{ width: 90 }}>
          <label htmlFor="cmp-top">Top N</label>
          <input id="cmp-top" type="number" min={1} max={20} value={topN} onChange={(e) => setTopN(Math.max(1, Math.min(20, Number(e.target.value) || 5)))} disabled={disabled} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="cmp-file">{modality === "FACE" ? "Probe image" : "Probe recording"}</label>
          <input id="cmp-file" type="file" accept={modality === "FACE" ? "image/*" : "audio/*"} onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={disabled} />
        </div>
        {modality === "VOICE" ? (
          <label className="recognition-confirm" style={{ flex: "0 0 auto", minWidth: 0 }} title="Split by speaker first. Each is compared separately.">
            <input type="checkbox" checked={diarize} onChange={(e) => setDiarize(e.target.checked)} disabled={disabled} />
            Several speakers
          </label>
        ) : null}
        <button type="submit" className="primary" disabled={!ready}>
          {busy ? "Comparing…" : "Compare Against This Gallery"}
        </button>
      </div>
      <p className="tiny faint">1:N against this gallery only. The result is logged whether or not it matches; a close call between two candidates is reported as indeterminate. A multi-speaker recording is one comparison per speaker, never an average.</p>
    </form>
  );
}

function MatchTable({ matches }: { matches: CompareOutcome["matches"] }) {
  if (matches.length === 0) return null;
  return (
    <table>
      <thead>
        <tr>
          <th>Candidate</th>
          <th>Distance</th>
          <th>Within Threshold</th>
        </tr>
      </thead>
      <tbody>
        {matches.map((m) => (
          <tr key={m.enrollmentId}>
            <td>{m.label === null ? <span className="mono">{m.entityId ?? m.enrollmentId}</span> : titleCase(m.label)}</td>
            <td className="mono">{m.distanceBp.toLocaleString("en-US").replace(/,/g, " ")} bp</td>
            <td className={m.withinThreshold ? "ok" : "faint"}>{m.withinThreshold ? "Yes" : "No"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Outcome({ outcome }: { outcome: CompareOutcome }) {
  return (
    <div className="recognition-outcome">
      <div className="spread">
        <h3>Result</h3>
        <span className={`badge ${DECISION_CLASS[outcome.decision]}`}>{titleCase(outcome.decision.replace(/_/g, " "))}</span>
        <span className="tiny faint">{outcome.reason}</span>
      </div>
      <p className="tiny faint">
        {outcome.compared} {outcome.compared === 1 ? "template" : "templates"} compared · threshold {outcome.thresholdBp.toLocaleString("en-US").replace(/,/g, " ")} bp · margin {outcome.marginBp} bp · {outcome.model}
        {outcome.diariser === null ? "" : ` · ${outcome.diariser}`} · probe <span className="mono">{outcome.probeHash.slice(0, 12)}…</span>
      </p>
      {outcome.speakers !== null ? (
        outcome.speakers.map((s) => (
          <div key={s.comparisonId} className="recognition-speaker">
            <div className="spread">
              <b>{s.speaker ?? "Speaker"}</b>
              {s.seconds === null ? null : <span className="tiny faint">{s.seconds.toFixed(1)} s</span>}
              <span className={`badge ${DECISION_CLASS[s.decision]}`}>{titleCase(s.decision.replace(/_/g, " "))}</span>
              <span className="tiny faint">{s.reason}</span>
              <span className="tiny faint mono">probe {s.probeHash.slice(0, 12)}…</span>
            </div>
            <MatchTable matches={s.matches} />
          </div>
        ))
      ) : (
        <MatchTable matches={outcome.matches} />
      )}
    </div>
  );
}

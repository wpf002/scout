"""Resolution service.

POST /resolve takes observations already gathered under one authorization by
the API, scores every candidate pair, applies the analyst's pinned decisions,
clusters with the transitivity guard, and returns every decision and every
cluster. It reads no database and holds no state between requests: the API
owns persistence, and the model file owns the parameters.
"""

from __future__ import annotations

import os
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from resolution import __version__
from resolution.cluster import Decision, Thresholds, apply_pins, classify, cluster
from resolution.model import SUPPORTED_KINDS, model_version, predict
from resolution.normalize import NORMALIZATION_VERSION, normalize_identifier
from resolution.records import EntityKind, ObservationIn, to_row

app = FastAPI(title="Scout resolution", version=__version__, docs_url=None, redoc_url=None)


def _threshold(name: str, kind: str | None, default: int) -> int:
    if kind is not None:
        per_kind = os.environ.get(f"{name}_{kind}")
        if per_kind:
            return int(per_kind)
    return int(os.environ.get(name, str(default)))


def thresholds_for(kind: str | None) -> Thresholds:
    """Env defaults, per-kind overrides, validated: the band cannot collapse."""
    try:
        return Thresholds(
            match_bp=_threshold("RESOLUTION_MATCH_THRESHOLD", kind, 9500),
            review_bp=_threshold("RESOLUTION_REVIEW_THRESHOLD", kind, 7000),
        )
    except ValueError as error:
        raise RuntimeError(str(error)) from error


class Health(BaseModel):
    status: str
    service: str
    version: str
    normalization_version: str
    models: dict[str, str | None]
    match_threshold_bp: int
    review_threshold_bp: int


@app.get("/healthz", response_model=Health)
def healthz() -> Health:
    t = thresholds_for(None)
    return Health(
        status="ok",
        service="resolution",
        version=__version__,
        normalization_version=NORMALIZATION_VERSION,
        models={k: model_version(k) for k in SUPPORTED_KINDS},
        match_threshold_bp=t.match_bp,
        review_threshold_bp=t.review_bp,
    )


@app.get("/version")
def version() -> dict[str, str]:
    return {"service": "resolution", "version": __version__, "normalization_version": NORMALIZATION_VERSION}


class NormalizeRequest(BaseModel):
    kind: str
    value: str


@app.post("/normalize")
def normalize(req: NormalizeRequest) -> dict[str, str | None]:
    return {"kind": req.kind, "normalized": normalize_identifier(req.kind, req.value), "version": NORMALIZATION_VERSION}


class Adjudication(BaseModel):
    left: str
    right: str
    decision: Literal["MATCH", "NON_MATCH", "INDETERMINATE"]


class ThresholdsIn(BaseModel):
    match_bp: int = Field(ge=0, le=10_000)
    review_bp: int = Field(ge=0, le=10_000)


class ResolveRequest(BaseModel):
    authorization_id: str = Field(min_length=1)
    entity_kind: EntityKind
    observations: list[ObservationIn]
    adjudications: list[Adjudication] = Field(default_factory=list)
    thresholds: ThresholdsIn | None = None


class DecisionOut(BaseModel):
    left: str
    right: str
    score_bp: int | None
    decision: str
    blocking_key: str
    features: dict[str, Any]
    pinned: bool


class ClusterOut(BaseModel):
    members: list[str]
    status: str
    pending_review: int
    conflicts: list[list[str]]
    label: str


class ResolveResponse(BaseModel):
    authorization_id: str
    entity_kind: str
    model_version: str
    normalization_version: str
    thresholds: ThresholdsIn
    decisions: list[DecisionOut]
    clusters: list[ClusterOut]
    counts: dict[str, int]


def _label(kind: str, rows: dict[str, dict[str, Any]], members: list[str]) -> str:
    prefer = {
        "PERSON": ("name", "email", "phone", "handle"),
        "ORG": ("name", "document_no"),
        "VESSEL": ("name", "mmsi", "imo"),
        "AIRCRAFT": ("tail", "icao_hex", "callsign"),
    }.get(kind, ("name",))
    for col in prefer:
        values = [rows[m][col] for m in members if rows[m].get(col)]
        if values:
            return max(set(values), key=values.count)
    return members[0]


@app.post("/resolve", response_model=ResolveResponse)
def resolve(req: ResolveRequest) -> ResolveResponse:
    if req.entity_kind not in SUPPORTED_KINDS:
        raise HTTPException(status_code=422, detail={"error": "unsupported-kind", "message": f"No model for {req.entity_kind}. Supported: {', '.join(SUPPORTED_KINDS)}."})

    version_ = model_version(req.entity_kind)
    if version_ is None:
        raise HTTPException(status_code=503, detail={"error": "no-model", "message": f"No trained model for {req.entity_kind}. Run: uv run python -m eval.evaluate --train"})

    try:
        t = (
            Thresholds(req.thresholds.match_bp, req.thresholds.review_bp)
            if req.thresholds is not None
            else thresholds_for(req.entity_kind)
        )
    except (ValueError, RuntimeError) as error:
        raise HTTPException(status_code=422, detail={"error": "forced-resolution", "message": str(error)}) from error

    # Duplicate ids would make one record two; keep the first.
    seen: set[str] = set()
    observations = [o for o in req.observations if not (o.id in seen or seen.add(o.id))]
    rows = [to_row(o) for o in observations]
    by_id = {r["unique_id"]: r for r in rows}
    ids = list(by_id)

    scores = predict(req.entity_kind, rows)
    decisions = [
        Decision(
            left=s.left, right=s.right, score_bp=s.score_bp, decision=classify(s.score_bp, t),
            blocking_key=s.blocking_key,
            features={"match_weight": s.weight, "probability": s.probability, "levels": s.levels, "bayes_factors": s.bayes_factors},
        )
        for s in scores
    ]
    decisions = apply_pins(decisions, [a.model_dump() for a in req.adjudications])
    clusters = cluster(ids, decisions)

    counts = {
        "observations": len(ids),
        "pairs": len(decisions),
        "match": sum(d.decision == "MATCH" for d in decisions),
        "non_match": sum(d.decision == "NON_MATCH" for d in decisions),
        "review": sum(d.decision == "REVIEW" for d in decisions),
        "indeterminate": sum(d.decision == "INDETERMINATE" for d in decisions),
        "pinned": sum(d.pinned for d in decisions),
        "entities": len(clusters),
        "resolved": sum(c.status == "RESOLVED" for c in clusters),
        "provisional": sum(c.status == "PROVISIONAL" for c in clusters),
        "disputed": sum(c.status == "DISPUTED" for c in clusters),
    }

    return ResolveResponse(
        authorization_id=req.authorization_id,
        entity_kind=req.entity_kind,
        model_version=version_,
        normalization_version=NORMALIZATION_VERSION,
        thresholds=ThresholdsIn(match_bp=t.match_bp, review_bp=t.review_bp),
        decisions=[DecisionOut(left=d.left, right=d.right, score_bp=d.score_bp, decision=d.decision, blocking_key=d.blocking_key, features=d.features, pinned=d.pinned) for d in decisions],
        clusters=[ClusterOut(members=c.members, status=c.status, pending_review=c.pending_review, conflicts=[list(p) for p in c.conflicts], label=_label(req.entity_kind, by_id, c.members)) for c in clusters],
        counts=counts,
    )

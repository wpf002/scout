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

import json
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from resolution import __version__
from resolution.cluster import Decision, Thresholds, apply_pins, classify, cluster
from resolution.model import PairScore, SUPPORTED_KINDS, TooManyPairs, model_version, predict
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


def _features_for(decision: str, s: PairScore) -> dict[str, Any]:
    """The comparison detail travels with MATCH and REVIEW decisions, which
    the review queue and the audit read. A NON_MATCH keeps its score and
    blocking key; its per-column evidence is recomputable and, at scale,
    most of the payload. RESOLUTION_FEATURES_FOR=all keeps everything."""
    keep = os.environ.get("RESOLUTION_FEATURES_FOR", "match,review").lower().split(",")
    if "all" in keep or decision.lower() in keep:
        return {"match_weight": s.weight, "probability": s.probability, "levels": s.levels, "bayes_factors": s.bayes_factors}
    return {"match_weight": s.weight, "probability": s.probability}


@dataclass
class _Prepared:
    version: str
    thresholds: Thresholds
    rows: list[dict[str, Any]]
    by_id: dict[str, dict[str, Any]]
    ids: list[str]


def _prepare(req: ResolveRequest) -> _Prepared:
    """The fast half: validate, resolve thresholds, flatten rows. Everything
    here is known before any scoring, so the stream can send its header from
    it while the slow half runs."""
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
    return _Prepared(version=version_, thresholds=t, rows=rows, by_id=by_id, ids=list(by_id))


def _score(req: ResolveRequest, prep: _Prepared) -> tuple[list[Decision], list[Any]]:
    """The slow half: predict, classify, pin, cluster."""
    try:
        scores = predict(req.entity_kind, prep.rows)
    except TooManyPairs as error:
        raise HTTPException(
            status_code=422,
            detail={"error": "too-many-pairs", "message": f"{error}. Tighten the blocking or raise RESOLUTION_MAX_PAIRS.", "per_rule": error.per_rule, "limit": error.limit},
        ) from error
    decisions = []
    for s in scores:
        outcome = classify(s.score_bp, prep.thresholds)
        decisions.append(Decision(left=s.left, right=s.right, score_bp=s.score_bp, decision=outcome, blocking_key=s.blocking_key, features=_features_for(outcome, s)))
    decisions = apply_pins(decisions, [a.model_dump() for a in req.adjudications])
    return decisions, cluster(prep.ids, decisions)


def _run(req: ResolveRequest) -> ResolveResponse:
    """The whole resolution, JSON in and JSON out. The plain route collects
    what the streaming one sends line by line."""
    prep = _prepare(req)
    version_ = prep.version
    t = prep.thresholds
    by_id = prep.by_id
    ids = prep.ids
    decisions, clusters = _score(req, prep)

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


@app.post("/resolve", response_model=ResolveResponse)
def resolve(req: ResolveRequest) -> ResolveResponse:
    return _run(req)


async def _ndjson_lines(request: Request) -> AsyncIterator[dict[str, Any]]:
    """Lines of the request body as they arrive, without holding the body."""
    buffer = b""
    async for chunk in request.stream():
        buffer += chunk
        while True:
            newline = buffer.find(b"\n")
            if newline == -1:
                break
            line = buffer[:newline].strip()
            buffer = buffer[newline + 1 :]
            if line:
                yield json.loads(line)
    tail = buffer.strip()
    if tail:
        yield json.loads(tail)


def _stream_run(req: ResolveRequest) -> Iterator[str]:
    """The run, line by line, header first. The header is sent before any
    scoring, so a caller sees bytes within a second however long the run
    takes; the slow work happens between the header line and the first
    decision line. A refusal during preparation is raised before the
    response starts and becomes an ordinary error status."""
    prep = _prepare(req)
    yield json.dumps({"type": "header", "authorization_id": req.authorization_id, "entity_kind": req.entity_kind, "model_version": prep.version, "normalization_version": NORMALIZATION_VERSION, "thresholds": {"match_bp": prep.thresholds.match_bp, "review_bp": prep.thresholds.review_bp}}) + "\n"
    try:
        decisions, clusters = _score(req, prep)
    except HTTPException as error:
        # The stream has begun, so a refusal here cannot change the status.
        # It travels as an error line the caller raises on.
        yield json.dumps({"type": "error", "detail": error.detail}) + "\n"
        return
    counts = {
        "observations": len(prep.ids), "pairs": len(decisions),
        "match": sum(d.decision == "MATCH" for d in decisions), "non_match": sum(d.decision == "NON_MATCH" for d in decisions),
        "review": sum(d.decision == "REVIEW" for d in decisions), "indeterminate": sum(d.decision == "INDETERMINATE" for d in decisions),
        "pinned": sum(d.pinned for d in decisions), "entities": len(clusters),
        "resolved": sum(c.status == "RESOLVED" for c in clusters), "provisional": sum(c.status == "PROVISIONAL" for c in clusters), "disputed": sum(c.status == "DISPUTED" for c in clusters),
    }
    for d in decisions:
        yield json.dumps({"type": "decision", "left": d.left, "right": d.right, "score_bp": d.score_bp, "decision": d.decision, "blocking_key": d.blocking_key, "features": d.features, "pinned": d.pinned}) + "\n"
    for c in clusters:
        yield json.dumps({"type": "cluster", "members": c.members, "status": c.status, "pending_review": c.pending_review, "conflicts": [list(p) for p in c.conflicts], "label": _label(req.entity_kind, prep.by_id, c.members)}) + "\n"
    yield json.dumps({"type": "summary", "counts": counts}) + "\n"


@app.post("/resolve/stream")
async def resolve_stream(request: Request) -> StreamingResponse:
    """NDJSON in, NDJSON out. The first line is the header (authorization,
    kind, adjudications, thresholds); every following line is one
    observation. The reply is the same run as /resolve, sent header-first so
    time-to-first-byte does not grow with the run."""
    header: dict[str, Any] | None = None
    observations: list[ObservationIn] = []
    async for line in _ndjson_lines(request):
        kind = line.get("type")
        if kind == "header":
            header = line
        elif kind == "observation":
            line.pop("type", None)
            observations.append(ObservationIn.model_validate(line))
        else:
            raise HTTPException(status_code=422, detail={"error": "bad-line", "message": f"unknown line type {kind!r}"})
    if header is None:
        raise HTTPException(status_code=422, detail={"error": "no-header", "message": "the first line must be the header"})
    req = ResolveRequest(
        authorization_id=header["authorization_id"], entity_kind=header["entity_kind"], observations=observations,
        adjudications=[Adjudication.model_validate(a) for a in header.get("adjudications", [])],
        thresholds=None if header.get("thresholds") is None else ThresholdsIn.model_validate(header["thresholds"]),
    )
    # _prepare runs once here so a bad kind or a collapsed band is a real
    # error status, not an error line inside a 200 stream.
    _prepare(req)
    return StreamingResponse(_stream_run(req), media_type="application/x-ndjson")

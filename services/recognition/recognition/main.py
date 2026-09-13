"""Recognition service entry point.

Two properties hold from the first line, before any model exists:

1. Every route except /healthz is refused unless RECOGNITION_ENABLED=true.
2. Both working routes require a gallery id in their schema. There is no
   route that accepts a probe without one, and there will not be one "for
   testing". Open-world identification is the thing this service cannot do.

The service is stateless. Scout's API is the custodian: it holds the
galleries, decrypts the enrolled templates for one comparison, hands them
in with the probe, and records the outcome. This process turns media into
a vector and ranks vectors; it stores nothing and never sees a template
key.
"""

from __future__ import annotations

import base64
import hashlib
import os

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from recognition import __version__
from recognition.compare import decide, rank
from recognition.diarize import diariser_for
from recognition.embedders import ModelUnavailable, NoSubject, embedder_for

app = FastAPI(title="Scout recognition", version=__version__, docs_url=None, redoc_url=None)


def enabled() -> bool:
    return os.environ.get("RECOGNITION_ENABLED", "false").lower() == "true"


def require_enabled() -> None:
    if not enabled():
        raise HTTPException(
            status_code=403,
            detail={"error": "feature-disabled", "message": "Recognition is disabled. Set RECOGNITION_ENABLED=true to enable it."},
        )


class Health(BaseModel):
    status: str
    service: str
    version: str
    enabled: bool
    gallery_only: bool = True
    embedder: str


@app.get("/healthz", response_model=Health)
def healthz() -> Health:
    return Health(
        status="ok", service="recognition", version=__version__, enabled=enabled(),
        embedder=os.environ.get("RECOGNITION_EMBEDDER", "models"),
    )


def _decode(media_b64: str) -> bytes:
    try:
        return base64.b64decode(media_b64, validate=True)
    except Exception as error:  # noqa: BLE001
        raise HTTPException(status_code=422, detail={"error": "bad-media", "message": f"media is not valid base64: {error}"}) from error


def _embed(modality: str, media: bytes, content_type: str) -> tuple[list[float], str]:
    try:
        embedder = embedder_for(modality)
        return embedder.embed(media, content_type), embedder.model
    except ModelUnavailable as error:
        raise HTTPException(status_code=503, detail={"error": "model-unavailable", "message": str(error)}) from error
    except NoSubject as error:
        raise HTTPException(status_code=422, detail={"error": "no-subject", "message": f"nothing to embed: {error}"}) from error


class EmbedRequest(BaseModel):
    """Media becomes a template for one named gallery. The purpose is fixed."""

    gallery_id: str = Field(min_length=1)
    purpose: str = Field(pattern="^enrollment$")
    modality: str = Field(pattern="^(FACE|VOICE)$")
    media_b64: str = Field(min_length=1)
    content_type: str = Field(default="application/octet-stream")


class EmbedResponse(BaseModel):
    model: str
    dims: int
    embedding: list[float]
    media_hash: str


@app.post("/embed", response_model=EmbedResponse, dependencies=[Depends(require_enabled)])
def embed(request: EmbedRequest) -> EmbedResponse:
    media = _decode(request.media_b64)
    vector, model = _embed(request.modality, media, request.content_type)
    return EmbedResponse(model=model, dims=len(vector), embedding=vector, media_hash=hashlib.sha256(media).hexdigest())


class Candidate(BaseModel):
    enrollment_id: str = Field(min_length=1)
    embedding: list[float] = Field(min_length=1)


class CompareRequest(BaseModel):
    """A probe is compared against one named gallery's templates. Nothing else."""

    gallery_id: str = Field(min_length=1)
    authorization_id: str = Field(min_length=1)
    modality: str = Field(pattern="^(FACE|VOICE)$")
    probe_media_b64: str | None = None
    probe_embedding: list[float] | None = None
    content_type: str = Field(default="application/octet-stream")
    candidates: list[Candidate] = Field(default_factory=list, max_length=10_000)
    threshold_bp: int = Field(ge=0, le=10_000)
    margin_bp: int = Field(default=500, ge=0, le=10_000)
    top_n: int = Field(default=5, ge=1, le=20)
    """Voice only: split the probe by speaker and compare each one on its own."""
    diarize: bool = False


class MatchOut(BaseModel):
    enrollment_id: str
    distance_bp: int


class SpeakerOut(BaseModel):
    speaker: str
    seconds: float | None
    probe_hash: str
    compared: int
    matches: list[MatchOut]
    decision: str
    reason: str


class CompareResponse(BaseModel):
    model: str
    probe_hash: str
    compared: int
    matches: list[MatchOut]
    decision: str
    reason: str
    """Present only for a diarised probe: one entry per speaker, each its own comparison."""
    speakers: list[SpeakerOut] | None = None
    diariser: str | None = None


def _rank_and_decide(probe: list[float], request: CompareRequest) -> tuple[list[MatchOut], str, str]:
    try:
        matches = rank(probe, [(c.enrollment_id, c.embedding) for c in request.candidates], request.top_n)
    except ValueError as error:
        raise HTTPException(status_code=422, detail={"error": "bad-embedding", "message": str(error)}) from error
    outcome = decide(matches, request.threshold_bp, request.margin_bp)
    return [MatchOut(enrollment_id=m.enrollment_id, distance_bp=m.distance_bp) for m in matches], outcome.decision, outcome.reason


def _compare_by_speaker(request: CompareRequest, media: bytes) -> CompareResponse:
    """One comparison per speaker. The top-level fields describe the speaker
    whose best candidate is nearest, and say so; the rows are in `speakers`."""
    try:
        diariser = diariser_for()
        parts = diariser.split(media, request.content_type)
    except ModelUnavailable as error:
        raise HTTPException(status_code=503, detail={"error": "model-unavailable", "message": str(error)}) from error
    except NoSubject as error:
        raise HTTPException(status_code=422, detail={"error": "no-subject", "message": f"nothing to diarise: {error}"}) from error
    speakers: list[SpeakerOut] = []
    model = "caller-supplied embedding"
    for part in parts:
        try:
            probe, model = _embed(request.modality, part.media, request.content_type)
        except HTTPException as error:
            detail = error.detail if isinstance(error.detail, dict) else {}
            if detail.get("error") == "no-subject":
                continue
            raise
        matches, decision, reason = _rank_and_decide(probe, request)
        speakers.append(SpeakerOut(
            speaker=part.speaker, seconds=part.seconds, probe_hash=hashlib.sha256(part.media).hexdigest(),
            compared=len(request.candidates), matches=matches, decision=decision, reason=reason,
        ))
    if not speakers:
        raise HTTPException(status_code=422, detail={"error": "no-subject", "message": "no speaker in the probe could be embedded"})
    lead = min(speakers, key=lambda s: (s.matches[0].distance_bp if s.matches else 10_001, s.speaker))
    return CompareResponse(
        model=model,
        probe_hash=hashlib.sha256(media).hexdigest(),
        compared=len(request.candidates),
        matches=lead.matches,
        decision=lead.decision,
        reason=f"{len(speakers)} speakers compared separately; leading with {lead.speaker}: {lead.reason}",
        speakers=speakers,
        diariser=diariser.model,
    )


@app.post("/compare", response_model=CompareResponse, dependencies=[Depends(require_enabled)])
def compare(request: CompareRequest) -> CompareResponse:
    if request.probe_media_b64 is None and request.probe_embedding is None:
        raise HTTPException(status_code=422, detail={"error": "no-probe", "message": "a probe (media or embedding) is required"})
    if request.diarize:
        if request.modality != "VOICE":
            raise HTTPException(status_code=422, detail={"error": "diarize-voice-only", "message": "diarisation applies to voice probes only"})
        if request.probe_media_b64 is None:
            raise HTTPException(status_code=422, detail={"error": "no-probe", "message": "diarisation needs the probe media, not an embedding"})
        return _compare_by_speaker(request, _decode(request.probe_media_b64))
    if request.probe_media_b64 is not None:
        media = _decode(request.probe_media_b64)
        probe, model = _embed(request.modality, media, request.content_type)
        probe_hash = hashlib.sha256(media).hexdigest()
    else:
        probe = request.probe_embedding or []
        model = "caller-supplied embedding"
        probe_hash = "embedding:" + hashlib.sha256(",".join(f"{x:.6f}" for x in probe).encode()).hexdigest()
    matches, decision, reason = _rank_and_decide(probe, request)
    return CompareResponse(model=model, probe_hash=probe_hash, compared=len(request.candidates), matches=matches, decision=decision, reason=reason)

"""Recognition service entry point.

Two properties hold from the first line, before any model exists:

1. Every route except /healthz is refused unless RECOGNITION_ENABLED=true.
2. A comparison request requires a gallery id in its schema. There is no
   route that accepts a probe without one, and there will not be one "for
   testing". Open-world identification is the thing this service cannot do.

The models themselves (ArcFace via InsightFace, ECAPA-TDNN via SpeechBrain)
arrive in Phase 10 behind these exact routes.
"""

from __future__ import annotations

import os

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field

from recognition import __version__

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


@app.get("/healthz", response_model=Health)
def healthz() -> Health:
    return Health(status="ok", service="recognition", version=__version__, enabled=enabled())


class CompareRequest(BaseModel):
    """A probe is compared against one named gallery. Nothing else."""

    gallery_id: str = Field(min_length=1)
    authorization_id: str = Field(min_length=1)
    modality: str = Field(pattern="^(FACE|VOICE)$")
    probe_ref: str = Field(min_length=1)
    top_n: int = Field(default=5, ge=1, le=20)


@app.post("/compare", dependencies=[Depends(require_enabled)])
def compare(request: CompareRequest) -> dict[str, str]:
    # Phase 10. Until then an enabled service still refuses to compare,
    # because there is no model and pretending otherwise would be a result
    # with no basis.
    raise HTTPException(
        status_code=501,
        detail={"error": "not-implemented", "message": f"Comparison against gallery {request.gallery_id} is not built yet."},
    )

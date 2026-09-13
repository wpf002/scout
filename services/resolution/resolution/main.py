"""Resolution service entry point.

Phase 2 skeleton. It answers /healthz and /version and nothing else. The
pipeline (normalize → block → score → threshold → cluster → persist) lands in
Phase 6 behind these same routes, and every route added then takes the scope
context the API forwards; there is no unscoped path into this service.
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from pydantic import BaseModel

from resolution import __version__

app = FastAPI(title="Scout resolution", version=__version__, docs_url=None, redoc_url=None)


class Health(BaseModel):
    status: str
    service: str
    version: str
    model_version: str | None
    match_threshold_bp: int
    review_threshold_bp: int


def _thresholds() -> tuple[int, int]:
    match = int(os.environ.get("RESOLUTION_MATCH_THRESHOLD", "9500"))
    review = int(os.environ.get("RESOLUTION_REVIEW_THRESHOLD", "7000"))
    # The review band can never be collapsed. The TypeScript side refuses the
    # same configuration; refusing here too means a misconfigured service will
    # not quietly force decisions if it is ever started on its own.
    if match <= review:
        raise RuntimeError(
            f"RESOLUTION_MATCH_THRESHOLD ({match}) must exceed RESOLUTION_REVIEW_THRESHOLD ({review})."
        )
    return match, review


@app.get("/healthz", response_model=Health)
def healthz() -> Health:
    match, review = _thresholds()
    return Health(
        status="ok",
        service="resolution",
        version=__version__,
        model_version=None,
        match_threshold_bp=match,
        review_threshold_bp=review,
    )


@app.get("/version")
def version() -> dict[str, str]:
    return {"service": "resolution", "version": __version__}

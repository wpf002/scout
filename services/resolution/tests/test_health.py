import os

import pytest
from fastapi.testclient import TestClient

from resolution.main import app


def test_healthz_reports_thresholds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RESOLUTION_MATCH_THRESHOLD", "9500")
    monkeypatch.setenv("RESOLUTION_REVIEW_THRESHOLD", "7000")
    body = TestClient(app).get("/healthz").json()
    assert body["status"] == "ok"
    assert body["match_threshold_bp"] == 9500
    assert body["review_threshold_bp"] == 7000
    assert set(body["models"]) == {"PERSON", "VESSEL", "AIRCRAFT", "ORG"}
    assert body["normalization_version"] == "norm-1"


def test_collapsed_review_band_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RESOLUTION_MATCH_THRESHOLD", "8000")
    monkeypatch.setenv("RESOLUTION_REVIEW_THRESHOLD", "8000")
    with pytest.raises(RuntimeError, match="must exceed"):
        TestClient(app, raise_server_exceptions=True).get("/healthz")

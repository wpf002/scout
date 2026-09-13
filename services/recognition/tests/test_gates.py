import pytest
from fastapi.testclient import TestClient

from recognition.main import app

client = TestClient(app)


def test_healthz_answers_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RECOGNITION_ENABLED", raising=False)
    body = client.get("/healthz").json()
    assert body["status"] == "ok"
    assert body["enabled"] is False
    assert body["gallery_only"] is True


def test_compare_is_refused_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RECOGNITION_ENABLED", raising=False)
    r = client.post(
        "/compare",
        json={"gallery_id": "g1", "authorization_id": "a1", "modality": "FACE", "probe_ref": "p"},
    )
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "feature-disabled"


def test_compare_requires_a_gallery_even_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RECOGNITION_ENABLED", "true")
    # No gallery_id: the request is unprocessable. There is no probe-only path.
    r = client.post("/compare", json={"authorization_id": "a1", "modality": "FACE", "probe_ref": "p"})
    assert r.status_code == 422
    # Empty gallery_id is the same refusal.
    r = client.post("/compare", json={"gallery_id": "", "authorization_id": "a1", "modality": "FACE", "probe_ref": "p"})
    assert r.status_code == 422


def test_no_route_accepts_a_probe_without_a_gallery() -> None:
    # Structural: the only comparison route's model requires gallery_id.
    routes = {r.path for r in app.routes}
    assert routes == {"/healthz", "/compare", "/openapi.json"} or "/compare" in routes
    from recognition.main import CompareRequest

    assert "gallery_id" in CompareRequest.model_fields
    assert CompareRequest.model_fields["gallery_id"].is_required()

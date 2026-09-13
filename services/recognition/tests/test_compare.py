import base64

import pytest
from fastapi.testclient import TestClient

from recognition.compare import Match, cosine_distance_bp, decide, rank
from recognition.embedders import DeterministicEmbedder, reset_embedders
from recognition.main import app

client = TestClient(app)


def test_cosine_distance_is_integer_basis_points() -> None:
    assert cosine_distance_bp([1.0, 0.0], [1.0, 0.0]) == 0
    assert cosine_distance_bp([1.0, 0.0], [0.0, 1.0]) == 10_000
    assert cosine_distance_bp([1.0, 0.0], [-1.0, 0.0]) == 10_000  # clamped, never past orthogonal
    assert cosine_distance_bp([1.0, 1.0], [1.0, 0.0]) == 2_929
    with pytest.raises(ValueError):
        cosine_distance_bp([1.0], [1.0, 2.0])
    with pytest.raises(ValueError):
        cosine_distance_bp([0.0, 0.0], [1.0, 0.0])


def test_rank_orders_by_distance_then_id_and_caps() -> None:
    ranked = rank([1.0, 0.0], [("b", [0.9, 0.1]), ("a", [0.9, 0.1]), ("far", [0.0, 1.0])], top_n=2)
    assert [m.enrollment_id for m in ranked] == ["a", "b"]


def test_decisions_never_call_a_close_race_a_match() -> None:
    assert decide([], 6_000, 500).decision == "INDETERMINATE"
    assert decide([Match("a", 7_000)], 6_000, 500).decision == "NO_MATCH"
    assert decide([Match("a", 1_000), Match("b", 1_300)], 6_000, 500).decision == "INDETERMINATE"
    assert decide([Match("a", 1_000), Match("b", 3_000)], 6_000, 500).decision == "MATCH"
    assert decide([Match("a", 1_000)], 6_000, 500).decision == "MATCH"


def test_deterministic_embedder_is_deterministic_and_discriminating() -> None:
    e = DeterministicEmbedder("FACE")
    a = e.embed(b"face A", "image/png")
    assert a == e.embed(b"face A", "image/png")
    assert cosine_distance_bp(a, e.embed(b"face B", "image/png")) > 6_000
    assert cosine_distance_bp(a, DeterministicEmbedder("VOICE").embed(b"face A", "image/png")) > 6_000


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def test_embed_and_compare_through_the_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RECOGNITION_ENABLED", "true")
    monkeypatch.setenv("RECOGNITION_EMBEDDER", "test")
    reset_embedders()
    enrolled = client.post("/embed", json={"gallery_id": "g1", "purpose": "enrollment", "modality": "FACE", "media_b64": _b64(b"face A")}).json()
    assert enrolled["dims"] == 64
    assert "not a recogniser" in enrolled["model"]

    same = client.post(
        "/compare",
        json={
            "gallery_id": "g1", "authorization_id": "auth", "modality": "FACE", "probe_media_b64": _b64(b"face A"),
            "candidates": [{"enrollment_id": "e1", "embedding": enrolled["embedding"]}], "threshold_bp": 6_000, "margin_bp": 500,
        },
    ).json()
    assert same["decision"] == "MATCH"
    assert same["matches"][0] == {"enrollment_id": "e1", "distance_bp": 0}
    assert same["compared"] == 1

    other = client.post(
        "/compare",
        json={
            "gallery_id": "g1", "authorization_id": "auth", "modality": "FACE", "probe_media_b64": _b64(b"face Z"),
            "candidates": [{"enrollment_id": "e1", "embedding": enrolled["embedding"]}], "threshold_bp": 6_000,
        },
    ).json()
    assert other["decision"] == "NO_MATCH"

    twins = client.post(
        "/compare",
        json={
            "gallery_id": "g1", "authorization_id": "auth", "modality": "FACE", "probe_media_b64": _b64(b"face A"),
            "candidates": [{"enrollment_id": "e1", "embedding": enrolled["embedding"]}, {"enrollment_id": "e2", "embedding": enrolled["embedding"]}],
            "threshold_bp": 6_000, "margin_bp": 500,
        },
    ).json()
    assert twins["decision"] == "INDETERMINATE"
    assert "margin" in twins["reason"]

    empty = client.post("/compare", json={"gallery_id": "g1", "authorization_id": "auth", "modality": "FACE", "probe_media_b64": _b64(b"face A"), "threshold_bp": 6_000}).json()
    assert empty["decision"] == "INDETERMINATE"
    assert "nothing was compared" in empty["reason"]


def test_embed_requires_a_gallery_and_the_enrollment_purpose(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RECOGNITION_ENABLED", "true")
    monkeypatch.setenv("RECOGNITION_EMBEDDER", "test")
    assert client.post("/embed", json={"purpose": "enrollment", "modality": "FACE", "media_b64": _b64(b"x")}).status_code == 422
    assert client.post("/embed", json={"gallery_id": "g1", "purpose": "probe", "modality": "FACE", "media_b64": _b64(b"x")}).status_code == 422


def test_without_models_a_real_embedder_is_unavailable_not_invented(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RECOGNITION_ENABLED", "true")
    monkeypatch.delenv("RECOGNITION_EMBEDDER", raising=False)
    reset_embedders()
    r = client.post("/embed", json={"gallery_id": "g1", "purpose": "enrollment", "modality": "FACE", "media_b64": _b64(b"x")})
    try:
        import insightface  # noqa: F401
    except ImportError:
        assert r.status_code == 503
        assert r.json()["detail"]["error"] == "model-unavailable"
        assert "uv sync --extra models" in r.json()["detail"]["message"]

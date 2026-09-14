import base64

import pytest
from fastapi.testclient import TestClient

from recognition.compare import Match, cosine_distance_bp, decide, rank
from recognition.diarize import DeterministicDiariser, reset_diarisers
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
        # Without the extra a real embedder is unavailable, never invented.
        assert r.status_code == 503
        assert r.json()["detail"]["error"] == "model-unavailable"
        assert "uv sync --extra models" in r.json()["detail"]["message"]
    else:
        # With the extra the model loads and rejects non-image bytes cleanly,
        # as a no-subject, not a crash.
        assert r.status_code == 422
        assert r.json()["detail"]["error"] == "no-subject"


def test_deterministic_diariser_splits_speakers_and_refuses_silence() -> None:
    parts = DeterministicDiariser().split(b"voice A|voice B|", "audio/wav")
    assert [p.speaker for p in parts] == ["SPEAKER_00", "SPEAKER_01"]
    assert parts[1].media == b"voice B"
    with pytest.raises(Exception):
        DeterministicDiariser().split(b"||", "audio/wav")


def test_a_multi_speaker_probe_is_one_comparison_per_speaker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RECOGNITION_ENABLED", "true")
    monkeypatch.setenv("RECOGNITION_EMBEDDER", "test")
    reset_embedders()
    reset_diarisers()
    enrolled_a = client.post("/embed", json={"gallery_id": "g1", "purpose": "enrollment", "modality": "VOICE", "media_b64": _b64(b"voice A")}).json()
    body = {
        "gallery_id": "g1", "authorization_id": "auth", "modality": "VOICE", "probe_media_b64": _b64(b"voice A|voice B"), "diarize": True,
        "candidates": [{"enrollment_id": "e-a", "embedding": enrolled_a["embedding"]}], "threshold_bp": 6_000, "margin_bp": 500,
    }
    r = client.post("/compare", json=body).json()
    assert r["diariser"].startswith("deterministic")
    assert [s["speaker"] for s in r["speakers"]] == ["SPEAKER_00", "SPEAKER_01"]
    assert r["speakers"][0]["decision"] == "MATCH"
    assert r["speakers"][1]["decision"] == "NO_MATCH"
    assert r["speakers"][0]["probe_hash"] != r["speakers"][1]["probe_hash"]
    # The top-level fields follow the leading speaker and say so.
    assert r["decision"] == "MATCH"
    assert "2 speakers compared separately" in r["reason"]

    face = client.post("/compare", json={**body, "modality": "FACE"})
    assert face.status_code == 422
    assert face.json()["detail"]["error"] == "diarize-voice-only"


def test_diarisation_without_the_model_is_unavailable_not_invented(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RECOGNITION_ENABLED", "true")
    monkeypatch.delenv("RECOGNITION_EMBEDDER", raising=False)
    reset_diarisers()
    try:
        import pyannote.audio  # noqa: F401
    except ImportError:
        r = client.post("/compare", json={"gallery_id": "g1", "authorization_id": "auth", "modality": "VOICE", "probe_media_b64": _b64(b"x"), "diarize": True, "threshold_bp": 6_000})
        assert r.status_code == 503
        assert r.json()["detail"]["error"] == "model-unavailable"

import pytest
from fastapi.testclient import TestClient

from resolution.main import app

client = TestClient(app)


def _obs(i: int, name: str, email: str | None) -> dict:
    identifiers = [{"kind": "NAME", "value": name}]
    if email is not None:
        identifiers.append({"kind": "EMAIL", "value": email})
    return {"id": f"o{i}", "identifiers": identifiers, "payload": {}}


def test_resolve_route_keeps_evidence_for_matches_and_reviews_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RESOLUTION_FEATURES_FOR", raising=False)
    body = {
        "authorization_id": "auth", "entity_kind": "PERSON",
        "observations": [
            _obs(1, "Ana Abara", "ana.abara@example.net"), _obs(2, "Ana Abara", "ana.abara@example.net"), _obs(3, "Ben Berg", "ben@example.org"),
            _obs(4, "Ana Abara", None), _obs(5, "Anna Abaro", "someone.else@example.org"), _obs(6, "Ana Abara", "different.person@example.org"),
        ],
        "adjudications": [],
    }
    r = client.post("/resolve", json=body)
    assert r.status_code == 200, r.text
    decisions = r.json()["decisions"]
    assert decisions, "expected scored pairs"
    kept = [d for d in decisions if d["decision"] in ("MATCH", "REVIEW")]
    non_matches = [d for d in decisions if d["decision"] == "NON_MATCH"]
    assert kept, "the identical records should at least reach the review band"
    assert all("levels" in d["features"] and "bayes_factors" in d["features"] for d in kept)
    # Pairs the blocking never proposes have no decision at all; the ones it
    # scores and rejects keep the score and lose the per-column evidence.
    for d in non_matches:
        assert set(d["features"]) == {"match_weight", "probability"}
    assert len(decisions) == len(kept) + len(non_matches)

    monkeypatch.setenv("RESOLUTION_FEATURES_FOR", "all")
    everything = client.post("/resolve", json=body).json()["decisions"]
    assert all("levels" in d["features"] for d in everything)

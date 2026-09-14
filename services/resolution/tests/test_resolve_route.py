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


def test_stream_route_answers_the_same_run_line_by_line(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RESOLUTION_FEATURES_FOR", raising=False)
    observations = [_obs(1, "Ana Abara", "ana.abara@example.net"), _obs(2, "Ana Abara", "ana.abara@example.net"), _obs(3, "Ben Berg", "ben@example.org")]
    body = "\n".join([__import__("json").dumps({"type": "header", "authorization_id": "auth", "entity_kind": "PERSON", "adjudications": []})] + [__import__("json").dumps({"type": "observation", **o}) for o in observations]) + "\n"
    r = client.post("/resolve/stream", content=body.encode(), headers={"content-type": "application/x-ndjson"})
    assert r.status_code == 200, r.text
    lines = [__import__("json").loads(line) for line in r.text.strip().split("\n")]
    assert lines[0]["type"] == "header" and lines[0]["entity_kind"] == "PERSON"
    assert lines[-1]["type"] == "summary" and lines[-1]["counts"]["observations"] == 3
    kinds = {line["type"] for line in lines}
    assert kinds == {"header", "decision", "cluster", "summary"}
    plain = client.post("/resolve", json={"authorization_id": "auth", "entity_kind": "PERSON", "observations": observations, "adjudications": []}).json()
    assert sum(1 for line in lines if line["type"] == "decision") == len(plain["decisions"])
    assert sum(1 for line in lines if line["type"] == "cluster") == len(plain["clusters"])
    assert client.post("/resolve/stream", content=b'{"type":"observation","id":"x"}\n').status_code == 422


def test_a_batch_that_blocks_too_wide_is_refused_before_scoring(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RESOLUTION_MAX_PAIRS", "10")
    # Five thousand records sharing one city and one metaphone block into millions of pairs.
    observations = [{"id": f"o{i}", "identifiers": [{"kind": "NAME", "value": "Ana Abara"}], "payload": {"city": "Valparaíso"}} for i in range(5_000)]
    r = client.post("/resolve", json={"authorization_id": "auth", "entity_kind": "PERSON", "observations": observations, "adjudications": []})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "too-many-pairs"
    assert detail["limit"] == 10
    assert any(n > 10 for n in detail["per_rule"].values())

"""End to end on the fixture: trains if no model exists, then holds the
recall gate. Slow (EM), so it is one test."""

import json
from pathlib import Path

from eval.evaluate import BASELINE, RECALL_TOLERANCE, run
from resolution.model import SUPPORTED_KINDS, model_path


def test_fixture_resolution_meets_the_baseline():
    need_training = any(not model_path(k).exists() for k in SUPPORTED_KINDS)
    report = run(train_first=need_training)
    assert report["kinds"], "no kinds evaluated"
    if BASELINE.exists():
        base = json.loads(BASELINE.read_text())
        for kind, m in base["kinds"].items():
            assert report["kinds"][kind]["pair"]["recall"] + RECALL_TOLERANCE >= m["pair"]["recall"], kind
    # Precision floor: a resolver that merges strangers is worse than none.
    for kind, m in report["kinds"].items():
        assert m["cluster"]["precision"] >= 0.95, (kind, m["cluster"])


def test_predict_survives_a_batch_with_an_all_null_text_column() -> None:
    """A batch with no addresses, cities or phones is ordinary. DuckDB would
    type those all-null columns as INTEGER and the string comparison would
    fail; the frame builder types them as text."""
    from resolution.model import predict
    from resolution.records import ObservationIn, to_row

    rows = [
        to_row(ObservationIn(id=f"o{i}", identifiers=[{"kind": "NAME", "value": f"Ana Abara {i // 2}"}, {"kind": "EMAIL", "value": f"ana.abara{i // 2}@example.net"}]))
        for i in range(8)
    ]
    assert all(r["address"] is None and r["phone"] is None and r["city"] is None for r in rows)
    scores = predict("PERSON", rows)
    assert len(scores) > 0
    assert any(s.probability > 0.9 for s in scores)

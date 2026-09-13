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

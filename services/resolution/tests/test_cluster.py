import pytest

from resolution.cluster import Decision, Thresholds, apply_pins, classify, cluster


def test_thresholds_refuse_a_collapsed_band():
    with pytest.raises(ValueError, match="must exceed"):
        Thresholds(match_bp=8000, review_bp=8000)
    with pytest.raises(ValueError):
        Thresholds(match_bp=7000, review_bp=9000)


def test_classify_keeps_the_review_band_and_indeterminate():
    t = Thresholds(9500, 7000)
    assert classify(9900, t) == "MATCH"
    assert classify(9500, t) == "MATCH"
    assert classify(8000, t) == "REVIEW"
    assert classify(6999, t) == "NON_MATCH"
    assert classify(None, t) == "INDETERMINATE"


def test_transitivity_guard_disputes_rather_than_merges():
    d = [
        Decision("A", "B", 9900, "MATCH", "k"),
        Decision("B", "C", 9800, "MATCH", "k"),
        Decision("A", "C", 1000, "NON_MATCH", "k"),
    ]
    [c] = cluster(["A", "B", "C"], d)
    assert c.status == "DISPUTED"
    assert c.conflicts == [("A", "C")]


def test_clean_component_is_resolved_and_singletons_are_provisional():
    d = [Decision("A", "B", 9900, "MATCH", "k"), Decision("B", "C", 9800, "MATCH", "k")]
    out = cluster(["A", "B", "C", "D"], d)
    assert [(c.members, c.status) for c in out] == [(["A", "B", "C"], "RESOLVED"), (["D"], "PROVISIONAL")]


def test_pins_outrank_the_model():
    model = [Decision("A", "B", 9900, "MATCH", "k"), Decision("B", "C", 8000, "REVIEW", "k")]
    pinned = apply_pins(model, [{"left": "B", "right": "A", "decision": "NON_MATCH"}, {"left": "C", "right": "D", "decision": "MATCH"}])
    by = {(d.left, d.right): d for d in pinned}
    assert by[("A", "B")].decision == "NON_MATCH" and by[("A", "B")].pinned and by[("A", "B")].score_bp == 9900
    assert by[("C", "D")].decision == "MATCH" and by[("C", "D")].score_bp is None
    out = cluster(["A", "B", "C", "D"], pinned)
    assert [(c.members, c.status) for c in out] == [(["A"], "PROVISIONAL"), (["B"], "PROVISIONAL"), (["C", "D"], "RESOLVED")]

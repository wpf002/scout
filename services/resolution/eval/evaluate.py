"""The evaluation harness.

Resolves the synthetic fixture from the file alone, scores against the
ground truth it carries, and reports precision, recall and F1 at pair and
cluster level per entity kind. `--train` fits the per-kind models first and
saves them under models/. `--check` fails when recall has fallen more than
RECALL_TOLERANCE below eval/baseline.json, unless `--override` gives a reason.

    uv run python -m eval.evaluate --train
    uv run python -m eval.evaluate --check
    uv run python -m eval.evaluate --write-baseline
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from resolution.cluster import Decision, Thresholds, classify, cluster
from resolution.model import SUPPORTED_KINDS, model_version, predict, train
from resolution.normalize import NORMALIZATION_VERSION
from resolution.records import ObservationIn, to_row

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "fixtures" / "synthetic.json"
BASELINE = HERE / "baseline.json"
LATEST = HERE / "latest.json"
RECALL_TOLERANCE = 0.005


def load_fixture() -> dict[str, list[dict[str, Any]]]:
    data = json.loads(FIXTURE.read_text())
    by_kind: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen: set[str] = set()
    for o in data["observations"]:
        if o["id"] in seen:
            continue
        seen.add(o["id"])
        by_kind[o["kind"]].append(o)
    return by_kind


def to_observation(o: dict[str, Any]) -> ObservationIn:
    return ObservationIn(
        id=o["id"],
        identifiers=o.get("identifiers", []),
        payload={k: v for k, v in o.get("payload", {}).items() if k != "_synthetic"},
        observed_at=datetime.fromisoformat(o["observedAt"].replace("Z", "+00:00")) if o.get("observedAt") else None,
        position=o.get("position"),
    )


def prf(tp: int, fp: int, fn: int) -> dict[str, float]:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return {"precision": round(p, 4), "recall": round(r, 4), "f1": round(f, 4), "tp": tp, "fp": fp, "fn": fn}


def evaluate_kind(kind: str, records: list[dict[str, Any]], t: Thresholds) -> dict[str, Any]:
    truth = {o["id"]: o["truthKey"] for o in records}
    ids = list(truth)
    truth_pairs = {tuple(sorted(p)) for p in itertools.combinations(ids, 2) if truth[p[0]] == truth[p[1]]}

    rows = [to_row(to_observation(o)) for o in records]
    scores = predict(kind, rows)
    decisions = [Decision(s.left, s.right, s.score_bp, classify(s.score_bp, t), s.blocking_key) for s in scores]
    predicted = {(d.left, d.right) for d in decisions if d.decision == "MATCH"}
    compared = {(d.left, d.right) for d in decisions}

    pair = prf(len(predicted & truth_pairs), len(predicted - truth_pairs), len(truth_pairs - predicted))
    # Blocking recall: of the true pairs, how many were even compared.
    blocking_recall = round(len(compared & truth_pairs) / len(truth_pairs), 4) if truth_pairs else 1.0

    clusters = cluster(ids, decisions)
    merged: set[tuple[str, str]] = set()
    for c in clusters:
        if c.status == "RESOLVED":
            merged |= {tuple(sorted(p)) for p in itertools.combinations(c.members, 2)}
    cluster_pairs = prf(len(merged & truth_pairs), len(merged - truth_pairs), len(truth_pairs - merged))

    review = sum(d.decision == "REVIEW" for d in decisions)
    review_true = sum(1 for d in decisions if d.decision == "REVIEW" and (d.left, d.right) in truth_pairs)
    return {
        "observations": len(ids),
        "truth_entities": len(set(truth.values())),
        "truth_pairs": len(truth_pairs),
        "compared_pairs": len(compared),
        "blocking_recall": blocking_recall,
        "pair": pair,
        "cluster": cluster_pairs,
        "review_pairs": review,
        "review_pairs_that_are_true": review_true,
        "entities": len(clusters),
        "disputed": sum(c.status == "DISPUTED" for c in clusters),
        "model_version": model_version(kind),
    }


def run(train_first: bool) -> dict[str, Any]:
    by_kind = load_fixture()
    t = Thresholds(match_bp=9500, review_bp=7000)
    report: dict[str, Any] = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "normalization_version": NORMALIZATION_VERSION,
        "thresholds": {"match_bp": t.match_bp, "review_bp": t.review_bp},
        "kinds": {},
    }
    for kind in SUPPORTED_KINDS:
        records = by_kind.get(kind, [])
        if len(records) < 2:
            continue
        if train_first:
            # Labels ride in a column the model never compares on.
            labelled = [{**to_row(to_observation(o)), "truth_key": o["truthKey"]} for o in records]
            train(kind, labelled, label_column="truth_key")
        report["kinds"][kind] = evaluate_kind(kind, records, t)

    weighted = [(k["truth_pairs"], k["pair"]["recall"], k["pair"]["precision"]) for k in report["kinds"].values()]
    total = sum(w for w, _, _ in weighted) or 1
    report["overall"] = {
        "pair_recall": round(sum(w * r for w, r, _ in weighted) / total, 4),
        "pair_precision": round(sum(w * p for w, _, p in weighted) / total, 4),
    }
    return report


def check(report: dict[str, Any], override: str | None) -> int:
    if not BASELINE.exists():
        print("no baseline; run --write-baseline")
        return 0
    base = json.loads(BASELINE.read_text())
    failures = []
    for kind, metrics in base.get("kinds", {}).items():
        now = report["kinds"].get(kind)
        if now is None:
            failures.append(f"{kind}: missing from report")
            continue
        if now["pair"]["recall"] + RECALL_TOLERANCE < metrics["pair"]["recall"]:
            failures.append(f"{kind}: pair recall {now['pair']['recall']} < baseline {metrics['pair']['recall']}")
    if failures and override:
        print("RECALL REGRESSION OVERRIDDEN:", override)
        for f in failures:
            print("  ", f)
        return 0
    if failures:
        print("RECALL REGRESSION:")
        for f in failures:
            print("  ", f)
        return 1
    print("recall gate: ok")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--write-baseline", action="store_true")
    parser.add_argument("--override", default=None, help="reason to accept a recall regression")
    args = parser.parse_args(argv)

    report = run(train_first=args.train)
    LATEST.write_text(json.dumps(report, indent=2))
    for kind, m in report["kinds"].items():
        print(f"{kind:9} obs={m['observations']:4} truth_pairs={m['truth_pairs']:5} blocked={m['blocking_recall']:.3f} "
              f"pair P/R/F1={m['pair']['precision']:.3f}/{m['pair']['recall']:.3f}/{m['pair']['f1']:.3f} "
              f"cluster P/R={m['cluster']['precision']:.3f}/{m['cluster']['recall']:.3f} review={m['review_pairs']} disputed={m['disputed']}")
    print("overall pair recall", report["overall"]["pair_recall"], "precision", report["overall"]["pair_precision"])

    if args.write_baseline:
        BASELINE.write_text(json.dumps(report, indent=2))
        print("baseline written")
    if args.check:
        return check(report, args.override)
    return 0


if __name__ == "__main__":
    sys.exit(main())

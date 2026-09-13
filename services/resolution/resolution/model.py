"""Fellegi–Sunter scoring with Splink, per entity kind.

The model for a kind is a JSON file: comparison levels, m and u probabilities,
the prior. Everything a pair's score came from is in that file and in the
per-pair feature vector, which is what makes a score explainable to someone
who did not write the code.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd
import splink.comparison_library as cl
from splink import DuckDBAPI, Linker, SettingsCreator, block_on

logging.getLogger("splink").setLevel(logging.ERROR)

MODEL_DIR = Path(os.environ.get("RESOLUTION_MODEL_DIR", Path(__file__).resolve().parent.parent / "models"))


@dataclass(frozen=True)
class BlockingRule:
    name: str
    columns: tuple[str, ...]


@dataclass(frozen=True)
class KindSpec:
    kind: str
    comparisons: list[Any]
    blocking: list[BlockingRule]
    deterministic: list[BlockingRule]
    em_sessions: list[BlockingRule]


def _spec(kind: str) -> KindSpec:
    if kind == "PERSON":
        return KindSpec(
            kind,
            comparisons=[
                cl.EmailComparison("email"),
                cl.ExactMatch("phone"),
                cl.ForenameSurnameComparison("first", "last"),
                cl.JaroWinklerAtThresholds("address", [0.92, 0.8]),
                cl.ExactMatch("handle"),
                cl.ExactMatch("device_id"),
                cl.ExactMatch("city"),
            ],
            blocking=[
                BlockingRule("exact:email", ("email",)),
                BlockingRule("exact:phone", ("phone",)),
                BlockingRule("exact:device_id", ("device_id",)),
                BlockingRule("exact:handle", ("handle",)),
                BlockingRule("metaphone+city", ("name_meta", "city")),
                BlockingRule("lsh:name", ("lsh_band",)),
                BlockingRule("geohash5+day", ("geohash5", "day_bucket")),
            ],
            deterministic=[BlockingRule("exact:email", ("email",)), BlockingRule("exact:phone", ("phone",))],
            em_sessions=[BlockingRule("em:email", ("email",)), BlockingRule("em:name", ("first", "last"))],
        )
    if kind == "VESSEL":
        return KindSpec(
            kind,
            comparisons=[
                cl.ExactMatch("mmsi"),
                cl.ExactMatch("imo"),
                cl.JaroWinklerAtThresholds("name", [0.92, 0.8]),
                cl.ExactMatch("callsign"),
            ],
            blocking=[
                BlockingRule("exact:mmsi", ("mmsi",)),
                BlockingRule("exact:imo", ("imo",)),
                BlockingRule("exact:name", ("name",)),
                BlockingRule("lsh:name", ("lsh_band",)),
            ],
            deterministic=[BlockingRule("exact:mmsi", ("mmsi",)), BlockingRule("exact:imo", ("imo",))],
            em_sessions=[BlockingRule("em:mmsi", ("mmsi",)), BlockingRule("em:name", ("name",))],
        )
    if kind == "AIRCRAFT":
        return KindSpec(
            kind,
            comparisons=[
                cl.ExactMatch("icao_hex"),
                cl.ExactMatch("tail"),
                cl.ExactMatch("callsign"),
            ],
            blocking=[
                BlockingRule("exact:icao_hex", ("icao_hex",)),
                BlockingRule("exact:tail", ("tail",)),
                BlockingRule("exact:callsign", ("callsign",)),
            ],
            deterministic=[BlockingRule("exact:icao_hex", ("icao_hex",))],
            em_sessions=[BlockingRule("em:icao_hex", ("icao_hex",)), BlockingRule("em:tail", ("tail",))],
        )
    if kind == "ORG":
        return KindSpec(
            kind,
            comparisons=[
                cl.JaroWinklerAtThresholds("name", [0.95, 0.85]),
                cl.ExactMatch("document_no"),
            ],
            blocking=[
                BlockingRule("exact:document_no", ("document_no",)),
                BlockingRule("exact:name", ("name",)),
                BlockingRule("lsh:name", ("lsh_band",)),
            ],
            deterministic=[BlockingRule("exact:document_no", ("document_no",))],
            em_sessions=[BlockingRule("em:document_no", ("document_no",)), BlockingRule("em:name", ("name",))],
        )
    raise ValueError(f"No resolution model is defined for entity kind {kind}.")


SUPPORTED_KINDS = ("PERSON", "VESSEL", "AIRCRAFT", "ORG")


def _settings(spec: KindSpec) -> SettingsCreator:
    return SettingsCreator(
        link_type="dedupe_only",
        comparisons=spec.comparisons,
        blocking_rules_to_generate_predictions=[block_on(*r.columns) for r in spec.blocking],
        retain_intermediate_calculation_columns=True,
    )


def model_path(kind: str) -> Path:
    return MODEL_DIR / f"{kind.lower()}.json"


def model_version(kind: str) -> str | None:
    path = model_path(kind)
    if not path.exists():
        return None
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    return f"splink-{kind.lower()}-{digest}"


def _level_counts(comparison: Any) -> int:
    """Non-null levels of a comparison, in the order `.configure()` expects."""
    levels = comparison.get_comparison("duckdb").comparison_levels
    return sum(1 for lvl in levels if not lvl.is_null_level)


def calibrate(kind: str, rows: list[dict[str, Any]], label_column: str, out: Path | None = None) -> Path:
    """m and u straight from labelled pairs.

    Random-sampling u assumes a random pair is almost never a match. In a
    fixture where every entity has three to six records, four per cent of all
    pairs are matches, so sampled u is contaminated and the model lands most
    true pairs in the review band. With labels there is no need to sample:
    for every comparison level, m is its frequency among pairs of the same
    entity and u its frequency among pairs of different entities, and the
    prior is the share of pairs that are matches. All of it is written into
    the model file, level by level, where it can be read.
    """
    spec = _spec(kind)
    frame = _frame(rows)
    scan = SettingsCreator(
        link_type="dedupe_only",
        comparisons=spec.comparisons,
        blocking_rules_to_generate_predictions=["1=1"],
        retain_intermediate_calculation_columns=True,
        additional_columns_to_retain=[label_column],
    )
    linker = Linker(frame, scan, db_api=DuckDBAPI())
    pairs = linker.inference.predict(threshold_match_probability=0.0).as_record_dict()
    names = [c.create_output_column_name() for c in spec.comparisons]

    same = [p for p in pairs if p[f"{label_column}_l"] == p[f"{label_column}_r"]]
    diff = [p for p in pairs if p[f"{label_column}_l"] != p[f"{label_column}_r"]]
    prior = len(same) / max(1, len(pairs))

    calibrated = []
    fresh = _spec(kind).comparisons
    for comparison, name in zip(fresh, names):
        k = _level_counts(comparison)
        # Position 0 is the top level, which Splink numbers as gamma k-1.
        def freq(group: list[dict[str, Any]], gamma: int) -> float:
            observed = [p for p in group if p.get(f"gamma_{name}", -1) >= 0]
            hits = sum(1 for p in observed if int(p[f"gamma_{name}"]) == gamma)
            # Add-one smoothing: an unobserved level is rare, not impossible.
            return (hits + 1) / (len(observed) + k)
        m = [freq(same, k - 1 - pos) for pos in range(k)]
        u = [freq(diff, k - 1 - pos) for pos in range(k)]
        calibrated.append(comparison.configure(m_probabilities=m, u_probabilities=u))

    final = SettingsCreator(
        link_type="dedupe_only",
        comparisons=calibrated,
        blocking_rules_to_generate_predictions=[block_on(*r.columns) for r in spec.blocking],
        probability_two_random_records_match=max(prior, 1e-6),
        retain_intermediate_calculation_columns=True,
    )
    path = out or model_path(kind)
    path.parent.mkdir(parents=True, exist_ok=True)
    Linker(frame.drop(columns=[label_column]), final, db_api=DuckDBAPI()).misc.save_model_to_json(str(path), overwrite=True)
    return path


def train(
    kind: str,
    rows: list[dict[str, Any]],
    out: Path | None = None,
    label_column: str | None = None,
) -> Path:
    """Fit a model for one kind.

    With labels, `calibrate()` computes every m and u from the labelled pairs.
    Without them, EM on unlabelled rows with u from random sampling, which is
    what a deployment with no fixture can do; the model file says which.
    """
    if label_column is not None:
        return calibrate(kind, rows, label_column, out)

    spec = _spec(kind)
    linker = Linker(_frame(rows), _settings(spec), db_api=DuckDBAPI())
    linker.training.estimate_probability_two_random_records_match(
        [block_on(*r.columns) for r in spec.deterministic], recall=0.7
    )
    linker.training.estimate_u_using_random_sampling(max_pairs=2_000_000)
    for session in spec.em_sessions:
        linker.training.estimate_parameters_using_expectation_maximisation(block_on(*session.columns))
    path = out or model_path(kind)
    path.parent.mkdir(parents=True, exist_ok=True)
    linker.misc.save_model_to_json(str(path), overwrite=True)
    return path


@dataclass
class PairScore:
    left: str
    right: str
    probability: float
    weight: float
    blocking_key: str
    levels: dict[str, int]
    bayes_factors: dict[str, float]

    @property
    def score_bp(self) -> int:
        return max(0, min(10_000, round(self.probability * 10_000)))


def _frame(rows: list[dict[str, Any]]) -> pd.DataFrame:
    """Rows as a DataFrame whose text columns are typed as text even when
    every value is null. DuckDB types an all-null object column as INTEGER,
    and a string comparison on it fails at predict time; a batch with no
    addresses (or no phones, or no cities) is ordinary, not an error."""
    frame = pd.DataFrame(rows)
    for column in frame.columns:
        values = frame[column].dropna()
        if len(values) == 0 or all(isinstance(v, str) for v in values):
            frame[column] = frame[column].astype("string")
    return frame


def predict(kind: str, rows: list[dict[str, Any]]) -> list[PairScore]:
    if len(rows) < 2:
        return []
    spec = _spec(kind)
    path = model_path(kind)
    if not path.exists():
        raise FileNotFoundError(
            f"No trained model for {kind} at {path}. Run: uv run python -m eval.evaluate --train"
        )
    linker = Linker(_frame(rows), str(path), db_api=DuckDBAPI())
    records = linker.inference.predict(threshold_match_probability=0.0).as_record_dict()
    names = [c.create_output_column_name() for c in spec.comparisons]
    out: list[PairScore] = []
    for r in records:
        left, right = str(r["unique_id_l"]), str(r["unique_id_r"])
        if left > right:
            left, right = right, left
        try:
            key = spec.blocking[int(r.get("match_key", 0))].name
        except (ValueError, IndexError):
            key = str(r.get("match_key"))
        out.append(
            PairScore(
                left=left,
                right=right,
                probability=float(r["match_probability"]),
                weight=float(r["match_weight"]),
                blocking_key=key,
                levels={n: int(r[f"gamma_{n}"]) for n in names if f"gamma_{n}" in r},
                bayes_factors={n: float(r[f"bf_{n}"]) for n in names if f"bf_{n}" in r},
            )
        )
    return out


def load_model_json(kind: str) -> dict[str, Any] | None:
    path = model_path(kind)
    return json.loads(path.read_text()) if path.exists() else None

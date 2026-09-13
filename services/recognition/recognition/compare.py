"""Distance and decision arithmetic. Pure functions, no model, no I/O.

Distances are integer basis points of cosine distance (0 = identical
direction, 10 000 = orthogonal or worse). Integers, never floats, cross the
service boundary, the way the resolution service reports scores.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

BP = 10_000


def cosine_distance_bp(a: list[float], b: list[float]) -> int:
    if len(a) != len(b) or not a:
        raise ValueError(f"embeddings differ in length ({len(a)} vs {len(b)}) or are empty")
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        raise ValueError("an embedding has zero norm")
    similarity = max(-1.0, min(1.0, dot / (na * nb)))
    distance = 1.0 - similarity
    return int(round(max(0.0, min(1.0, distance)) * BP))


@dataclass(frozen=True)
class Match:
    enrollment_id: str
    distance_bp: int


@dataclass(frozen=True)
class Decision:
    decision: str  # MATCH | NO_MATCH | INDETERMINATE
    reason: str


def rank(probe: list[float], candidates: list[tuple[str, list[float]]], top_n: int) -> list[Match]:
    scored = [Match(enrollment_id=eid, distance_bp=cosine_distance_bp(probe, emb)) for eid, emb in candidates]
    scored.sort(key=lambda m: (m.distance_bp, m.enrollment_id))
    return scored[: max(1, top_n)]


def decide(matches: list[Match], threshold_bp: int, margin_bp: int) -> Decision:
    """MATCH only when the best candidate is inside the threshold *and* clear
    of the runner-up by the margin. A close call is INDETERMINATE, never a
    confident identity. No candidates is INDETERMINATE too: nothing was
    compared, so nothing was excluded."""
    if not matches:
        return Decision("INDETERMINATE", "the gallery has no active template for this modality; nothing was compared")
    best = matches[0]
    if best.distance_bp > threshold_bp:
        return Decision("NO_MATCH", f"best candidate at {best.distance_bp} bp is outside the threshold of {threshold_bp} bp")
    if len(matches) > 1:
        runner = matches[1]
        if runner.distance_bp - best.distance_bp < margin_bp:
            return Decision(
                "INDETERMINATE",
                f"top two candidates are {runner.distance_bp - best.distance_bp} bp apart, inside the ambiguity margin of {margin_bp} bp",
            )
    return Decision("MATCH", f"best candidate at {best.distance_bp} bp, inside the threshold of {threshold_bp} bp")

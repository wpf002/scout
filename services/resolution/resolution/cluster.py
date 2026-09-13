"""Thresholds, pins, connected components, the transitivity guard."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Literal

Outcome = Literal["MATCH", "NON_MATCH", "REVIEW", "INDETERMINATE"]
Status = Literal["RESOLVED", "PROVISIONAL", "DISPUTED"]


@dataclass(frozen=True)
class Thresholds:
    match_bp: int
    review_bp: int

    def __post_init__(self) -> None:
        for v in (self.match_bp, self.review_bp):
            if not (0 <= v <= 10_000):
                raise ValueError("thresholds are basis points between 0 and 10000")
        if self.match_bp <= self.review_bp:
            raise ValueError(
                f"match threshold ({self.match_bp}) must exceed review threshold ({self.review_bp}); a collapsed review band forces every borderline pair."
            )


def classify(score_bp: int | None, t: Thresholds) -> Outcome:
    if score_bp is None:
        return "INDETERMINATE"
    if score_bp >= t.match_bp:
        return "MATCH"
    if score_bp < t.review_bp:
        return "NON_MATCH"
    return "REVIEW"


@dataclass
class Decision:
    left: str
    right: str
    score_bp: int | None
    decision: Outcome
    blocking_key: str
    features: dict = field(default_factory=dict)
    pinned: bool = False


def pair_key(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a <= b else (b, a)


def apply_pins(decisions: list[Decision], adjudications: list[dict]) -> list[Decision]:
    """A human's call outranks the model. Pinned pairs keep their score for
    the record but take the adjudicated outcome; a pinned pair the model never
    compared is added with no score."""
    pins = {pair_key(a["left"], a["right"]): a["decision"] for a in adjudications}
    seen: set[tuple[str, str]] = set()
    out: list[Decision] = []
    for d in decisions:
        key = pair_key(d.left, d.right)
        seen.add(key)
        if key in pins:
            out.append(Decision(d.left, d.right, d.score_bp, pins[key], d.blocking_key, d.features, pinned=True))
        else:
            out.append(d)
    for key, outcome in pins.items():
        if key not in seen:
            out.append(Decision(key[0], key[1], None, outcome, "adjudication", {}, pinned=True))
    return out


@dataclass
class Cluster:
    members: list[str]
    status: Status
    pending_review: int = 0
    conflicts: list[tuple[str, str]] = field(default_factory=list)


class _UnionFind:
    def __init__(self, ids: list[str]) -> None:
        self.parent = {i: i for i in ids}

    def find(self, x: str) -> str:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def cluster(ids: list[str], decisions: list[Decision]) -> list[Cluster]:
    """Connected components over MATCH edges.

    The guard: if any pair inside a component was decided NON_MATCH, the
    component is DISPUTED and is not merged. A–B match, B–C match, A–C
    non-match is three records that are not one entity, and the answer is to
    ask a person, not to pick a side.
    """
    uf = _UnionFind(ids)
    for d in decisions:
        if d.decision == "MATCH" and d.left in uf.parent and d.right in uf.parent:
            uf.union(d.left, d.right)

    groups: dict[str, list[str]] = defaultdict(list)
    for i in ids:
        groups[uf.find(i)].append(i)

    root_of = {i: uf.find(i) for i in ids}
    conflicts: dict[str, list[tuple[str, str]]] = defaultdict(list)
    reviews: dict[str, int] = defaultdict(int)
    for d in decisions:
        if d.left not in root_of or d.right not in root_of:
            continue
        same = root_of[d.left] == root_of[d.right]
        if same and d.decision == "NON_MATCH":
            conflicts[root_of[d.left]].append(pair_key(d.left, d.right))
        if d.decision in ("REVIEW", "INDETERMINATE"):
            reviews[root_of[d.left]] += 1
            if not same:
                reviews[root_of[d.right]] += 1

    out: list[Cluster] = []
    for root, members in groups.items():
        members.sort()
        if conflicts[root]:
            status: Status = "DISPUTED"
        elif len(members) > 1:
            status = "RESOLVED"
        else:
            status = "PROVISIONAL"
        out.append(Cluster(members=members, status=status, pending_review=reviews[root], conflicts=conflicts[root]))
    out.sort(key=lambda c: c.members[0])
    return out

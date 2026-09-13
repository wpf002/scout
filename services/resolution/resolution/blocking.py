"""Blocking keys. Never compare all pairs.

Each key is a column the Splink linker can block on with equality. The
n-gram LSH band is the fuzzy one: two names that share most trigrams land in
the same band often enough to be compared, without comparing every name to
every other.
"""

from __future__ import annotations

import hashlib
from datetime import datetime

import pygeohash

LSH_HASHES = 4
LSH_BAND_SIZE = 2


def trigrams(text: str) -> set[str]:
    padded = f"  {text} "
    return {padded[i : i + 3] for i in range(len(padded) - 2)}


def _h(seed: int, gram: str) -> int:
    return int.from_bytes(hashlib.blake2b(gram.encode(), digest_size=8, salt=seed.to_bytes(4, "little")).digest(), "little")


def lsh_band(text: str | None) -> str | None:
    """MinHash over trigrams, banded. Same band ⇒ worth comparing."""
    if not text:
        return None
    grams = trigrams(text)
    if not grams:
        return None
    mins = [min(_h(seed, g) for g in grams) for seed in range(LSH_HASHES)]
    band = mins[:LSH_BAND_SIZE]
    return hashlib.blake2b(":".join(str(m) for m in band).encode(), digest_size=6).hexdigest()


def geohash5(lat: float | None, lon: float | None) -> str | None:
    if lat is None or lon is None:
        return None
    return pygeohash.encode(lat, lon, precision=5)


def day_bucket(observed_at: datetime | None) -> str | None:
    return observed_at.date().isoformat() if observed_at is not None else None

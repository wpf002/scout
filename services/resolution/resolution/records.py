"""What the API sends, and the flat row the linker scores."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from resolution.blocking import day_bucket, geohash5, lsh_band
from resolution.normalize import (
    name_metaphone,
    name_parts,
    normalize_identifier,
)

EntityKind = Literal[
    "PERSON", "ORG", "VESSEL", "AIRCRAFT", "VEHICLE", "ACCOUNT", "LOCATION", "DEVICE", "INFRASTRUCTURE"
]


class Identifier(BaseModel):
    kind: str
    value: str


class Position(BaseModel):
    lon: float
    lat: float


class ObservationIn(BaseModel):
    id: str = Field(min_length=1)
    identifiers: list[Identifier] = Field(default_factory=list)
    payload: dict[str, Any] = Field(default_factory=dict)
    observed_at: datetime | None = None
    position: Position | None = None


ROW_COLUMNS = [
    "unique_id", "email", "phone", "name", "first", "last", "name_meta", "address", "city",
    "handle", "device_id", "mmsi", "imo", "icao_hex", "tail", "document_no", "callsign",
    "geohash5", "day_bucket", "lsh_band",
]

_KIND_TO_COLUMN = {
    "EMAIL": "email", "PHONE": "phone", "NAME": "name", "ADDRESS": "address",
    "HANDLE": "handle", "DEVICE_ID": "device_id", "MMSI": "mmsi", "IMO": "imo",
    "ICAO_HEX": "icao_hex", "TAIL_NUMBER": "tail", "DOCUMENT_NO": "document_no",
}


def to_row(obs: ObservationIn) -> dict[str, Any]:
    """One flat row. The first identifier of each kind wins; the rest are kept
    on the observation and will be scored when multi-valued comparisons land."""
    row: dict[str, Any] = {c: None for c in ROW_COLUMNS}
    row["unique_id"] = obs.id
    for ident in obs.identifiers:
        col = _KIND_TO_COLUMN.get(ident.kind)
        if col is None or row[col] is not None:
            continue
        row[col] = normalize_identifier(ident.kind, ident.value)

    payload = obs.payload
    city = payload.get("city") or payload.get("seenNear")
    if isinstance(city, str) and city.strip():
        row["city"] = normalize_identifier("NAME", city)
    callsign = payload.get("callsign")
    if isinstance(callsign, str) and callsign.strip():
        row["callsign"] = normalize_identifier("TAIL_NUMBER", callsign)

    row["first"], row["last"] = name_parts(row["name"])
    row["name_meta"] = name_metaphone(row["name"])
    row["lsh_band"] = lsh_band(row["name"])
    if obs.position is not None:
        row["geohash5"] = geohash5(obs.position.lat, obs.position.lon)
    row["day_bucket"] = day_bucket(obs.observed_at)
    return row

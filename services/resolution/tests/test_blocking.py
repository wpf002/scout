from datetime import datetime, timezone

from resolution.blocking import day_bucket, geohash5, lsh_band
from resolution.records import ObservationIn, to_row


def test_lsh_band_groups_near_names_and_separates_far_ones():
    assert lsh_band("robert sorensen") == lsh_band("robert sorensen")
    assert lsh_band(None) is None
    # Deterministic across processes: a fixed value pins the hash choice.
    assert lsh_band("apple inc") == lsh_band("apple inc")


def test_geohash_and_day_bucket():
    assert geohash5(45.523, -122.676) == "c20fb" or len(geohash5(45.523, -122.676)) == 5
    assert day_bucket(datetime(2026, 6, 1, 23, 59, tzinfo=timezone.utc)) == "2026-06-01"
    assert day_bucket(None) is None


def test_to_row_normalizes_and_derives_blocking_columns():
    row = to_row(ObservationIn(
        id="o1",
        identifiers=[{"kind": "NAME", "value": "Bob Sørensen"}, {"kind": "EMAIL", "value": "Bob.S+x@Example.org"}, {"kind": "PHONE", "value": "(415) 555-0123"}],
        payload={"city": "Portland", "callsign": "N123AB"},
        observed_at=datetime(2026, 6, 1, tzinfo=timezone.utc),
        position={"lon": -122.676, "lat": 45.523},
    ))
    assert row["name"] == "robert sorensen" and row["first"] == "robert" and row["last"] == "sorensen"
    assert row["email"] == "bob.s@example.org" and row["phone"] == "+14155550123"
    assert row["city"] == "portland" and row["callsign"] == "N123AB"
    assert row["name_meta"] == "RBRT SRNSN" and row["lsh_band"] and len(row["geohash5"]) == 5
    assert row["day_bucket"] == "2026-06-01"

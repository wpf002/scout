"""Per-kind identifier normalization, versioned.

Every rule here changes what matches what, so the version is recorded on
every run and every identifier row. Change a rule, bump the version, and the
resolver knows which records were normalized under which rule.
"""

from __future__ import annotations

import re

import jellyfish
import phonenumbers
from unidecode import unidecode

NORMALIZATION_VERSION = "norm-1"

# Nickname → given name. Applied to the first token only. Kept small and
# obvious; a nickname map that guesses is a merge that guesses.
NICKNAMES: dict[str, str] = {
    "bill": "william", "billy": "william", "will": "william",
    "bob": "robert", "bobby": "robert", "rob": "robert",
    "liz": "elizabeth", "beth": "elizabeth", "betty": "elizabeth",
    "mike": "michael", "jim": "james", "jimmy": "james",
    "jen": "jennifer", "jenny": "jennifer",
    "kate": "katherine", "kathy": "katherine", "katie": "katherine",
    "dan": "daniel", "danny": "daniel", "tom": "thomas", "tommy": "thomas",
    "meg": "margaret", "maggie": "margaret", "chris": "christopher",
}

GMAIL_HOSTS = {"gmail.com", "googlemail.com"}

ADDRESS_ABBREVIATIONS: dict[str, str] = {
    "st": "street", "str": "street", "ave": "avenue", "av": "avenue",
    "rd": "road", "blvd": "boulevard", "dr": "drive", "ln": "lane",
    "ct": "court", "pl": "place", "sq": "square", "hwy": "highway",
    "n": "north", "s": "south", "e": "east", "w": "west",
}
UNIT_WORDS = {"apt", "apartment", "unit", "suite", "ste", "#", "flat", "floor", "fl"}

_WS = re.compile(r"\s+")
_PUNCT = re.compile(r"[^\w\s-]")


def fold(value: str) -> str:
    """ASCII, lowercase, single spaces."""
    return _WS.sub(" ", unidecode(value).lower()).strip()


def normalize_email(value: str) -> str | None:
    v = value.strip().lower()
    at = v.rfind("@")
    if at <= 0 or at == len(v) - 1:
        return None
    local, host = v[:at], v[at + 1 :]
    # Plus-addressing routes to the same box everywhere that supports it.
    plus = local.find("+")
    if plus > 0:
        local = local[:plus]
    # Gmail ignores dots in the local part. Other providers do not, and
    # stripping them there would merge two people.
    if host in GMAIL_HOSTS:
        local = local.replace(".", "")
    if not local:
        return None
    return f"{local}@{host}"


def normalize_phone(value: str, region: str = "US") -> str | None:
    """E.164, or digits when the number does not parse."""
    try:
        parsed = phonenumbers.parse(value, region)
        if phonenumbers.is_possible_number(parsed):
            return phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
    except phonenumbers.NumberParseException:
        pass
    digits = re.sub(r"\D", "", value)
    return digits if len(digits) >= 7 else None


def normalize_name(value: str) -> str | None:
    """Folded, punctuation dropped, nickname expanded on the first token."""
    v = _PUNCT.sub(" ", fold(value)).replace("-", " ")
    tokens = [t for t in v.split() if t]
    if not tokens:
        return None
    tokens[0] = NICKNAMES.get(tokens[0], tokens[0])
    return " ".join(tokens)


def name_parts(name_norm: str | None) -> tuple[str | None, str | None]:
    if not name_norm:
        return None, None
    tokens = name_norm.split()
    if len(tokens) == 1:
        return tokens[0], None
    return tokens[0], tokens[-1]


def name_metaphone(name_norm: str | None) -> str | None:
    """Metaphone of each token, for blocking on how a name sounds."""
    if not name_norm:
        return None
    codes = [jellyfish.metaphone(t) for t in name_norm.split() if len(t) > 1]
    codes = [c for c in codes if c]
    return " ".join(codes) or None


def normalize_address(value: str) -> str | None:
    """Folded, abbreviations expanded, unit designators dropped.

    libpostal is the better parser and is not required: it needs a system
    library many machines do not have. This is the fallback and it says so
    through the version.
    """
    v = _PUNCT.sub(" ", fold(value)).replace(",", " ")
    out: list[str] = []
    skip_next = False
    for token in v.split():
        if skip_next:
            skip_next = False
            continue
        if token in UNIT_WORDS:
            skip_next = True
            continue
        out.append(ADDRESS_ABBREVIATIONS.get(token, token))
    return " ".join(out) or None


def normalize_identifier(kind: str, value: str) -> str | None:
    v = value.strip()
    if not v:
        return None
    if kind == "EMAIL":
        return normalize_email(v)
    if kind == "PHONE":
        return normalize_phone(v)
    if kind == "NAME":
        return normalize_name(v)
    if kind == "ADDRESS":
        return normalize_address(v)
    if kind == "HANDLE":
        return fold(v).lstrip("@") or None
    if kind in {"DOMAIN", "URL", "IP", "ICAO_HEX", "HASH"}:
        return fold(v).replace(" ", "") or None
    if kind in {"TAIL_NUMBER", "PLATE", "MMSI", "IMO", "DOCUMENT_NO", "DEVICE_ID"}:
        return re.sub(r"[\s-]", "", unidecode(v)).upper() or None
    return fold(v) or None

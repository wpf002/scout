from resolution.normalize import (
    name_metaphone,
    normalize_address,
    normalize_email,
    normalize_identifier,
    normalize_name,
    normalize_phone,
)


def test_email_plus_and_gmail_dots():
    assert normalize_email("Bob.Smith+news@Gmail.com") == "bobsmith@gmail.com"
    # Dots matter everywhere except Gmail; stripping them elsewhere merges two people.
    assert normalize_email("bob.smith+x@example.org") == "bob.smith@example.org"
    assert normalize_email("not-an-email") is None


def test_phone_to_e164():
    assert normalize_phone("(415) 555-0123") == "+14155550123"
    assert normalize_phone("415.555.0123") == "+14155550123"
    assert normalize_phone("+1 415 555 0123") == "+14155550123"
    assert normalize_phone("12") is None


def test_name_nickname_and_transliteration():
    assert normalize_name("Bob Sørensen") == "robert sorensen"
    assert normalize_name("W. Okafor") == "w okafor"
    assert normalize_name("ELIZABETH   O'Neil") == "elizabeth o neil"
    assert name_metaphone("robert sorensen") == "RBRT SRNSN"


def test_address_expands_and_drops_unit():
    assert normalize_address("123 Maple St, Portland") == "123 maple street portland"
    assert normalize_address("123 Maple Street Apt 4, Portland") == "123 maple street portland"


def test_hard_identifiers_fold_case_and_spacing():
    assert normalize_identifier("TAIL_NUMBER", "n123 ab") == "N123AB"
    assert normalize_identifier("ICAO_HEX", "ABC123") == "abc123"
    assert normalize_identifier("MMSI", "257 123 456") == "257123456"
    assert normalize_identifier("HANDLE", "@Bob.Smith") == "bob.smith"

"""Canonical phone normalization for compliance / contacts matching."""

from __future__ import annotations

import re

_NON_DIGIT = re.compile(r"\D+")


def normalize_phone(raw: str | None) -> str:
    """Return E.164-ish canonical form for matching (opt-out, contacts).

    Accepts ``+573001234567``, ``573001234567``, ``00573001234567``,
    ``+57 300 123 4567``, local ``3001234567``, etc.
    """
    s = (raw or "").strip()
    if not s:
        return ""
    digits = _NON_DIGIT.sub("", s)
    if not digits:
        return ""
    # ITU international prefix 00… (and US 011…) before country code.
    while digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("011") and len(digits) > 11:
        digits = digits[3:]
    if not digits:
        return ""
    if len(digits) == 10 and digits.startswith("3"):
        return f"+57{digits}"
    if digits.startswith("57") and len(digits) >= 12:
        return f"+{digits}"
    return f"+{digits}"

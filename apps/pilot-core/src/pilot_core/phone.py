"""Canonical phone normalization for compliance / contacts matching."""

from __future__ import annotations

import re

_NON_DIGIT = re.compile(r"\D+")


def normalize_phone(raw: str | None) -> str:
    """Return E.164-ish canonical form for matching (opt-out, contacts).

    Accepts ``+573001234567``, ``573001234567``, ``+57 300 123 4567``, etc.
    Colombian 10-digit mobiles starting with 3 get ``+57`` prefix.
    """
    s = (raw or "").strip()
    if not s:
        return ""
    digits = _NON_DIGIT.sub("", s)
    if not digits:
        return ""
    if len(digits) == 10 and digits.startswith("3"):
        return f"+57{digits}"
    if digits.startswith("57") and len(digits) >= 12:
        return f"+{digits}"
    if s.startswith("+"):
        return f"+{digits}"
    return f"+{digits}"

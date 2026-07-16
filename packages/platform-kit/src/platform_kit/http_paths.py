"""Bounded path templates for rate-limit keys and Prometheus labels (AUD-025/026)."""

from __future__ import annotations

import re

_UUID = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
_HEX = re.compile(r"^[0-9a-fA-F]{8,}$")
_NUM = re.compile(r"^\d{2,}$")
_PHONEISH = re.compile(r"^\+?\d{7,15}$")
_TOKENISH = re.compile(r"^[A-Za-z0-9_-]{20,}$")
_MAX_SEGMENTS = 12
_MAX_LABEL_LEN = 120


def normalize_route_path(path: str) -> str:
    """Collapse high-cardinality path segments into stable placeholders."""
    raw = (path or "/").split("?", 1)[0]
    if not raw.startswith("/"):
        raw = "/" + raw
    parts = raw.split("/")
    out: list[str] = []
    for i, seg in enumerate(parts):
        if i == 0 and seg == "":
            out.append("")
            continue
        if not seg:
            continue
        if len(out) >= _MAX_SEGMENTS:
            out.append("{…}")
            break
        if _UUID.match(seg) or _HEX.match(seg) or _NUM.match(seg) or _PHONEISH.match(seg):
            out.append("{id}")
        elif _TOKENISH.match(seg):
            out.append("{token}")
        elif len(seg) > 64:
            out.append("{long}")
        else:
            out.append(seg)
    normalized = "/".join(out) or "/"
    if not normalized.startswith("/"):
        normalized = "/" + normalized
    return normalized[:_MAX_LABEL_LEN]

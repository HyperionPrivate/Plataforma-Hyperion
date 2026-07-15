"""PII masking helpers for Ops GET responses."""

from __future__ import annotations

from typing import Any


def mask_phone(value: str | None) -> str:
    if not value:
        return ""
    s = str(value).strip()
    if len(s) <= 4:
        return "****"
    return f"{s[:3]}******{s[-2:]}"


def mask_document(value: str | None) -> str:
    if not value:
        return ""
    s = str(value).strip()
    if s in {"-", "—"}:
        return s
    if len(s) <= 4:
        return "****"
    return f"{'*' * max(4, len(s) - 4)}{s[-4:]}"


def mask_name(value: str | None) -> str:
    if not value:
        return ""
    parts = str(value).strip().split()
    if not parts:
        return ""
    if len(parts) == 1:
        p = parts[0]
        return p[0] + "***" if len(p) > 1 else "***"
    return f"{parts[0]} {' '.join(p[0] + '.' for p in parts[1:])}"


def pii_masking_enabled() -> bool:
    from pilot_core import ops_store

    ui = ops_store.get_setting("ui") or {}
    if isinstance(ui, dict) and "pii_masking" in ui:
        return bool(ui.get("pii_masking"))
    return True  # default on for Ops displays


def mask_conversation(conv: dict[str, Any]) -> dict[str, Any]:
    out = dict(conv)
    exp = dict(out.get("expediente") or {})
    if "cedula" in exp:
        exp["cedula"] = mask_document(exp.get("cedula"))
    if "phone" in exp:
        exp["phone"] = mask_phone(exp.get("phone"))
    out["expediente"] = exp
    if out.get("phone"):
        out["phone"] = mask_phone(out.get("phone"))
    if out.get("name"):
        out["name"] = mask_name(out.get("name"))
    return out


def mask_handoff_row(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    if out.get("name"):
        out["name"] = mask_name(out.get("name"))
    info = out.get("info")
    if isinstance(info, dict):
        info = dict(info)
        if info.get("phone"):
            info["phone"] = mask_phone(info.get("phone"))
        out["info"] = info
    return out


def mask_crm_card(card: dict[str, Any]) -> dict[str, Any]:
    out = dict(card)
    if out.get("name"):
        out["name"] = mask_name(out.get("name"))
    if out.get("phone"):
        out["phone"] = mask_phone(out.get("phone"))
    return out


def mask_contact(contact: dict[str, Any]) -> dict[str, Any]:
    out = dict(contact)
    if out.get("phone"):
        out["phone"] = mask_phone(out.get("phone"))
    if out.get("first_name"):
        out["first_name"] = mask_name(out.get("first_name"))
    return out

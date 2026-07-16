"""PII masking helpers for Ops GET responses (AUD-006)."""

from __future__ import annotations

from typing import Any

from platform_kit.auth import AuthContext

_PHONE_KEYS = frozenset(
    {
        "phone",
        "contact_phone",
        "to_number",
        "called_number",
        "external_number",
    }
)


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
    """Tenant UI preference (default on). Prefer should_mask_pii(ctx) for routes."""
    from pilot_core import ops_store

    ui = ops_store.get_setting("ui") or {}
    if isinstance(ui, dict) and "pii_masking" in ui:
        return bool(ui.get("pii_masking"))
    return True


def should_mask_pii(ctx: AuthContext | None = None) -> bool:
    """AUD-006: non-admin always masked; admin may unmask only via ui.pii_masking=false."""
    if ctx is None or "admin" not in (ctx.roles or ()):
        return True
    return pii_masking_enabled()


def mask_phone_fields(obj: Any, *, depth: int = 0) -> Any:
    """Recursively mask phone-like keys in dict/list payloads."""
    if depth > 8:
        return obj
    if isinstance(obj, list):
        return [mask_phone_fields(x, depth=depth + 1) for x in obj]
    if not isinstance(obj, dict):
        return obj
    out: dict[str, Any] = {}
    for k, v in obj.items():
        key = str(k)
        if key in _PHONE_KEYS and isinstance(v, (str, int)):
            out[key] = mask_phone(str(v))
        elif key in {"cedula", "document_id", "document"} and isinstance(v, (str, int)):
            out[key] = mask_document(str(v))
        elif isinstance(v, (dict, list)):
            out[key] = mask_phone_fields(v, depth=depth + 1)
        else:
            out[key] = v
    return out


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
    if out.get("phone"):
        out["phone"] = mask_phone(out.get("phone"))
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


def mask_dispatch(row: dict[str, Any]) -> dict[str, Any]:
    return mask_phone_fields(row)


def mask_segmentation_point(point: dict[str, Any]) -> dict[str, Any]:
    out = dict(point)
    if out.get("phone"):
        out["phone"] = mask_phone(out.get("phone"))
    if out.get("name"):
        out["name"] = mask_name(str(out.get("name")))
    return out

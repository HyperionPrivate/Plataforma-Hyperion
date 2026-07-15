"""product_flow — perfiles A (Renovación) / B (Reactivación)."""

from __future__ import annotations

from typing import Any, Literal

from pilot_core.modules.agent_config.service import agent_config_service
from pilot_core.settings import get_settings

FlowCode = Literal["A", "B"]


def normalize_flow(raw: str | None) -> FlowCode:
    return "B" if str(raw or "A").strip().upper() == "B" else "A"


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def resolve_product_flow(
    flow: str | None = "A",
    *,
    agent_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve voice + WA + CRM profile for Flujo A or B."""
    code: FlowCode = normalize_flow(flow)
    payload = payload or {}

    # Prefer explicit dynamic vars from ElevenLabs / ops body.
    data = _as_dict(payload.get("data"))
    init = _as_dict(data.get("conversation_initiation_client_data"))
    dyn = _as_dict(init.get("dynamic_variables"))
    for key in ("product_flow", "flujo", "flow"):
        if payload.get(key):
            code = normalize_flow(str(payload[key]))
            break
        if dyn.get(key):
            code = normalize_flow(str(dyn[key]))
            break

    cfg = agent_config_service.get()
    block_key = "flujo_a" if code == "A" else "flujo_b"
    block = _as_dict(cfg.get(block_key))

    # Match agent_id from webhook if flow not explicit.
    if agent_id:
        for letter, key in (("A", "flujo_a"), ("B", "flujo_b")):
            b = _as_dict(cfg.get(key))
            if str(b.get("agent_id") or "") == str(agent_id):
                code = letter  # type: ignore[assignment]
                block_key = key
                block = b
                break

    settings = get_settings()
    if code == "B":
        explicit_b = str(block.get("liwa_flow_id") or "").strip() or (
            settings.liwa_flow_id_b or ""
        ).strip()
        wa_flow = explicit_b or (settings.liwa_default_flow_id or "").strip()
        tag = (
            str(block.get("liwa_handoff_tag") or "").strip()
            or (settings.liwa_handoff_tag_b or "").strip()
            or "REACTIVACION_VIP"
        )
        funnel = "Reactivación"
        segment = "Reactivacion"
        wa_fallback = not bool(explicit_b)
        continue_label = "reactivar"
    else:
        wa_flow = (
            str(block.get("liwa_flow_id") or "").strip()
            or (settings.liwa_default_flow_id or "").strip()
        )
        tag = (
            str(block.get("liwa_handoff_tag") or "").strip()
            or (settings.liwa_handoff_tag or "").strip()
            or "RENOVACION_VIP"
        )
        funnel = "Renovación"
        segment = "Renovacion"
        wa_fallback = False
        continue_label = "renovar"

    return {
        "flow": code,
        "block_key": block_key,
        "name": str(block.get("name") or f"Flujo {code}"),
        "segment": segment,
        "crm_funnel": funnel,
        "agent_id": str(block.get("agent_id") or ""),
        "phone_number_id": str(block.get("phone_number_id") or ""),
        "from_number": str(block.get("from_number") or ""),
        "liwa_flow_id": wa_flow,
        "liwa_handoff_tag": tag,
        "liwa_flow_fallback_to_a": wa_fallback,
        "document_kind": "orden_matricula",
        "continue_label": continue_label,
        "wa_followup_text": (
            "Seguimiento post-llamada reactivación — envíe su orden de matrícula."
            if code == "B"
            else "Seguimiento post-llamada renovación — envíe su orden de matrícula."
        ),
    }

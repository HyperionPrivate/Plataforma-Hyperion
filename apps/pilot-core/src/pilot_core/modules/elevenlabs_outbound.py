"""elevenlabs_outbound — direct SIP trunk outbound for PULSO (no Contabo dialer required)."""

from __future__ import annotations

from typing import Any

import httpx

from pilot_core.modules.agent_config.service import agent_config_service
from pilot_core.modules.lead_context import (
    build_dynamic_variables,
    display_name_from_contact,
    find_contact,
)
from pilot_core.settings import get_settings

_API = "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call"


def resolve_flow(flow: str = "A") -> dict[str, str]:
    cfg = agent_config_service.get()
    key = "flujo_a" if str(flow).upper() != "B" else "flujo_b"
    raw_block = cfg.get(key)
    block: dict[str, Any] = raw_block if isinstance(raw_block, dict) else {}
    settings = get_settings()
    agent_id = str(block.get("agent_id") or "")
    phone_id = str(
        block.get("phone_number_id")
        or getattr(settings, "dialer_default_phone_number_id", "")
        or ""
    )
    return {
        "flow": key,
        "agent_id": agent_id,
        "agent_phone_number_id": phone_id,
        "name": str(block.get("name") or key),
    }


async def place_sip_outbound(
    *,
    to_number: str,
    flow: str = "A",
    first_name: str = "Asociado",
    lead: dict[str, Any] | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    api_key = (getattr(settings, "elevenlabs_api_key", None) or "").strip()
    if not api_key:
        return {"ok": False, "error": "elevenlabs_api_key_missing"}

    resolved = resolve_flow(flow)
    if not resolved["agent_id"] or not resolved["agent_phone_number_id"]:
        return {
            "ok": False,
            "error": "agent_or_phone_not_configured",
            "resolved": resolved,
        }

    contact = lead or find_contact(to_number)
    resolved_name = display_name_from_contact(contact, first_name)
    dyn = build_dynamic_variables(
        phone=to_number,
        first_name=resolved_name,
        flow=flow,
        contact=contact,
    )

    body = {
        "agent_id": resolved["agent_id"],
        "agent_phone_number_id": resolved["agent_phone_number_id"],
        "to_number": to_number,
        "conversation_initiation_client_data": {
            "dynamic_variables": dyn,
        },
    }
    async with httpx.AsyncClient(timeout=45.0) as client:
        resp = await client.post(
            _API,
            json=body,
            headers={"xi-api-key": api_key, "Content-Type": "application/json"},
        )
        try:
            raw = resp.json()
        except Exception:
            raw = {"raw": resp.text[:800]}
        data: dict[str, Any] = raw if isinstance(raw, dict) else {"raw": raw}
        nested_raw = data.get("data")
        nested: dict[str, Any] = nested_raw if isinstance(nested_raw, dict) else {}
        conv_id = (
            data.get("conversation_id")
            or data.get("conversationId")
            or nested.get("conversation_id")
        )
        conv_id_s = str(conv_id).strip() if conv_id else ""
        # AUD-015: HTTP 200 {} / success sin conversation_id no es envío.
        ok = bool(resp.is_success and conv_id_s and data.get("success", True) is not False)
        return {
            "ok": ok,
            "http_status": resp.status_code,
            "provider": "elevenlabs_sip_trunk",
            "resolved": resolved,
            "conversation_id": conv_id_s or None,
            "dynamic_variables": dyn,
            "response": data,
            "error": None if ok else ("missing_conversation_id" if resp.is_success else "provider_error"),
        }

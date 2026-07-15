"""elevenlabs_outbound — direct SIP trunk outbound for PULSO (no Contabo dialer required)."""

from __future__ import annotations

from typing import Any

import httpx

from pilot_core.modules.agent_config.service import agent_config_service
from pilot_core.settings import get_settings

_API = "https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call"


def resolve_flow(flow: str = "A") -> dict[str, str]:
    cfg = agent_config_service.get()
    key = "flujo_a" if str(flow).upper() != "B" else "flujo_b"
    block = cfg.get(key) if isinstance(cfg.get(key), dict) else {}
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

    body = {
        "agent_id": resolved["agent_id"],
        "agent_phone_number_id": resolved["agent_phone_number_id"],
        "to_number": to_number,
        "conversation_initiation_client_data": {
            "dynamic_variables": {
                "nombre": first_name,
                "first_name": first_name,
                "phone": to_number,
            }
        },
    }
    async with httpx.AsyncClient(timeout=45.0) as client:
        resp = await client.post(
            _API,
            json=body,
            headers={"xi-api-key": api_key, "Content-Type": "application/json"},
        )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text[:800]}
            conv_id = None
            if isinstance(data, dict):
                nested = data.get("data") if isinstance(data.get("data"), dict) else {}
                conv_id = (
                    data.get("conversation_id")
                    or data.get("conversationId")
                    or nested.get("conversation_id")
                )
            return {
                "ok": resp.is_success
                and bool(data.get("success", True) if isinstance(data, dict) else resp.is_success),
                "http_status": resp.status_code,
                "provider": "elevenlabs_sip_trunk",
                "resolved": resolved,
                "conversation_id": conv_id,
                "response": data,
            }

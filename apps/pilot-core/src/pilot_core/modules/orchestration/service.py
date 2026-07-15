"""orchestration — attempt outbound contact via compliance + dialer/ElevenLabs."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import httpx

from pilot_core import ops_store
from pilot_core.modules.campaigns.service import campaigns_service
from pilot_core.modules.compliance.service import compliance_service
from pilot_core.modules.elevenlabs_outbound import place_sip_outbound
from pilot_core.settings import get_settings


class OrchestrationService:
    name: str = "orchestration"

    def ping(self) -> str:
        return self.name

    async def attempt_call(
        self,
        *,
        phone: str,
        first_name: str = "Asociado",
        campaign_id: str | None = None,
        flow: str = "A",
        tenant_id: str = "tenant-dev",
    ) -> dict[str, Any]:
        decision = compliance_service.evaluate(phone=phone, channel="voz")
        if not decision.allowed:
            return {
                "ok": False,
                "blocked": True,
                "compliance": compliance_service.as_dict(decision),
            }

        settings = get_settings()
        dialer_url = (getattr(settings, "dialer_base_url", None) or "").rstrip("/")
        api_key = (getattr(settings, "elevenlabs_api_key", None) or "").strip()

        payload: dict[str, Any] = {
            "lead": {"phone": phone, "first_name": first_name},
            "campaign_id": campaign_id,
            "flow": flow,
            "tenant_id": tenant_id,
            "compliance": compliance_service.as_dict(decision),
        }

        # Prefer HTTP dialer microservice if configured.
        if dialer_url:
            phone_id = getattr(settings, "dialer_default_phone_number_id", "") or ""
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    f"{dialer_url}/internal/dialer/calls/dispatch",
                    json={
                        "lead": {"phone": phone, "first_name": first_name},
                        "agent_phone_number_id": phone_id or None,
                    },
                    headers={"X-Tenant-Id": tenant_id},
                )
                try:
                    data = resp.json()
                except Exception:
                    data = {"raw": resp.text[:500]}
                entry = {
                    "id": f"orch_{uuid4().hex[:10]}",
                    "mode": "live_dialer",
                    "http_status": resp.status_code,
                    "provider_response": data,
                    "status": "sent" if resp.is_success else "failed",
                    **payload,
                }
                ops_store.insert_dispatch(entry)
                if campaign_id and resp.is_success:
                    campaigns_service.bump_contacted(campaign_id)
                return {
                    "ok": resp.is_success,
                    "mock_commercial": False,
                    "dispatch": entry,
                }

        # Direct ElevenLabs SIP trunk (PULSO CoopFuturo numbers).
        if api_key:
            result = await place_sip_outbound(to_number=phone, flow=flow, first_name=first_name)
            entry = {
                "id": f"orch_{uuid4().hex[:10]}",
                "mode": "elevenlabs_sip",
                "status": "sent" if result.get("ok") else "failed",
                "conversation_id": result.get("conversation_id"),
                "provider_response": result,
                **payload,
            }
            ops_store.insert_dispatch(entry)
            if campaign_id and result.get("ok"):
                campaigns_service.bump_contacted(campaign_id)
            return {
                "ok": bool(result.get("ok")),
                "mock_commercial": False,
                "dispatch": entry,
                "provider": "elevenlabs_sip_trunk",
            }

        entry = {
            "id": f"orch_{uuid4().hex[:10]}",
            "mode": "mock",
            "status": "queued_mock",
            **payload,
        }
        ops_store.insert_dispatch(entry)
        if campaign_id:
            campaigns_service.bump_contacted(campaign_id)
        return {"ok": True, "mock_commercial": True, "dispatch": entry}


orchestration_service = OrchestrationService()

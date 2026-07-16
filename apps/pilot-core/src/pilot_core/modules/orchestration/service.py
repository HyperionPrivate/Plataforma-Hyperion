"""orchestration — attempt outbound contact via compliance + dialer/ElevenLabs."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import httpx

from pilot_core import ops_store
from pilot_core.modules.activity import human_voice_status, record_outbound_conversation
from pilot_core.modules.campaigns.service import campaigns_service
from pilot_core.modules.compliance.service import compliance_service
from pilot_core.modules.dialer_safety import assert_safe_dialer_url
from pilot_core.modules.elevenlabs_outbound import place_sip_outbound
from pilot_core.modules.lead_context import display_name_from_contact, find_contact
from pilot_core.modules.post_call.watcher import schedule_watch
from pilot_core.phone import normalize_phone
from pilot_core.settings import get_settings


class OrchestrationService:
    name: str = "orchestration"

    def ping(self) -> str:
        return self.name

    def _record_inbox(
        self,
        *,
        phone: str,
        first_name: str,
        status: str,
    ) -> None:
        # Always key inbox threads by phone so voz + WhatsApp share one Conversaciones row.
        record_outbound_conversation(
            phone=phone,
            first_name=first_name,
            channel="voz",
            snippet=f"Llamada de voz {human_voice_status(status)}",
            topic="Llamada de voz",
        )

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
        phone_n = normalize_phone(phone) or phone.strip()
        contact = find_contact(phone_n)
        resolved_name = display_name_from_contact(contact, first_name)

        payload: dict[str, Any] = {
            "lead": {
                "phone": phone_n,
                "first_name": resolved_name,
                "contact_id": (contact or {}).get("id"),
                "university": (contact or {}).get("university")
                or (contact or {}).get("universidad"),
                "segment": (contact or {}).get("segment"),
            },
            "campaign_id": campaign_id,
            "flow": flow,
            "tenant_id": tenant_id,
            "compliance": compliance_service.as_dict(decision),
        }

        # PULSO native path: ElevenLabs SIP trunk (preferred). Legacy Contabo dialer
        # is only a fallback when no API key is configured.
        if api_key:
            result = await place_sip_outbound(
                to_number=phone_n,
                flow=flow,
                first_name=resolved_name,
                lead=contact,
            )
            entry = {
                "id": f"orch_{uuid4().hex[:10]}",
                "mode": "elevenlabs_sip",
                "status": "sent" if result.get("ok") else "failed",
                "conversation_id": result.get("conversation_id"),
                "provider_response": result,
                "dynamic_variables": result.get("dynamic_variables"),
                **payload,
            }
            ops_store.insert_dispatch(entry)
            self._record_inbox(phone=phone_n, first_name=resolved_name, status=str(entry["status"]))
            if result.get("ok") and result.get("conversation_id"):
                # Respaldo: al colgar, tipifica + WA aunque el webhook de ElevenLabs falle.
                schedule_watch(
                    str(result["conversation_id"]),
                    dispatch_id=str(entry.get("id") or "") or None,
                    phone=phone_n,
                    first_name=resolved_name,
                    flow=flow,
                    tenant_id=tenant_id,
                )
            if campaign_id and result.get("ok"):
                campaigns_service.bump_contacted(campaign_id)
            return {
                "ok": bool(result.get("ok")),
                "mock_commercial": False,
                "dispatch": entry,
                "provider": "elevenlabs_sip_trunk",
            }

        if dialer_url:
            dialer_url = assert_safe_dialer_url(dialer_url)
            phone_id = getattr(settings, "dialer_default_phone_number_id", "") or ""
            async with httpx.AsyncClient(timeout=30.0, follow_redirects=False) as client:
                resp = await client.post(
                    f"{dialer_url}/internal/dialer/calls/dispatch",
                    json={
                        "lead": {"phone": phone_n, "first_name": resolved_name},
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
                self._record_inbox(
                    phone=phone_n, first_name=resolved_name, status=str(entry["status"])
                )
                if campaign_id and resp.is_success:
                    campaigns_service.bump_contacted(campaign_id)
                return {
                    "ok": resp.is_success,
                    "mock_commercial": False,
                    "dispatch": entry,
                }

        if not settings.mocks_allowed():
            return {
                "ok": False,
                "mock_commercial": False,
                "error": "voice_provider_unconfigured",
                "detail": "Configure ELEVENLABS_API_KEY or DIALER_BASE_URL (mocks disabled)",
            }
        entry = {
            "id": f"orch_{uuid4().hex[:10]}",
            "mode": "mock",
            "status": "queued_mock",
            **payload,
        }
        ops_store.insert_dispatch(entry)
        self._record_inbox(phone=phone_n, first_name=resolved_name, status="queued_mock")
        # Mock queue is not a real send — do not bump campaign contacted.
        return {"ok": True, "mock_commercial": True, "dispatch": entry}


orchestration_service = OrchestrationService()

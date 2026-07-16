"""WhatsApp channel mock — LIWA real blocked until credential rotation."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from pilot_core import ops_store
from pilot_core.modules.activity import record_outbound_conversation


class WhatsAppMockService:
    name: str = "whatsapp_mock"
    mode: str = "mock"  # never pretend real LIWA

    def ping(self) -> str:
        return self.name

    def send_text(
        self,
        *,
        phone: str,
        text: str,
        template: str | None = None,
        first_name: str = "",
    ) -> dict[str, Any]:
        from pilot_core.settings import get_settings

        if not get_settings().mocks_allowed():
            return {
                "ok": False,
                "mock_commercial": False,
                "error": "whatsapp_mock_disabled",
                "message": {"status": "failed", "error": "whatsapp_mock_disabled"},
            }
        entry = {
            "id": f"wa_{uuid4().hex[:10]}",
            "channel": "whatsapp",
            "mode": self.mode,
            "status": "queued_mock",
            "to": phone,
            "text": text[:500],
            "template": template,
            "provider": "liwa_mock",
        }
        # Reuse dispatches table for outbound audit trail.
        ops_store.insert_dispatch(
            {
                "id": entry["id"],
                "mode": "whatsapp_mock",
                "status": "queued_mock",
                "lead": {"phone": phone, "first_name": first_name or ""},
                "whatsapp": entry,
            }
        )
        thread = record_outbound_conversation(
            phone=phone,
            first_name=first_name or "Asociado",
            channel="whatsapp",
            snippet=text[:160]
            or (f"Plantilla WhatsApp · {template}" if template else "Mensaje WhatsApp encolado"),
            topic="WhatsApp",
        )
        # queued_mock is not a provider receipt — ok=True only signals local queue.
        return {
            "ok": True,
            "mock_commercial": True,
            "message": entry,
            "delivery": "queued_mock",
            "conversation_id": thread.get("id"),
        }


whatsapp_mock_service = WhatsAppMockService()

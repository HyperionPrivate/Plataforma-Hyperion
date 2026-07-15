"""WhatsApp channel mock — LIWA real blocked until credential rotation."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from pilot_core import ops_store


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
    ) -> dict[str, Any]:
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
                "lead": {"phone": phone, "first_name": ""},
                "whatsapp": entry,
            }
        )
        return {"ok": True, "mock_commercial": True, "message": entry}


whatsapp_mock_service = WhatsAppMockService()

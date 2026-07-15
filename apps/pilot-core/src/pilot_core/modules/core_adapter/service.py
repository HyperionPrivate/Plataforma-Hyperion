"""core_adapter — stub until Coopfuturo core API is confirmed."""

from __future__ import annotations

from typing import Any


class CoreAdapterService:
    name: str = "core_adapter"
    mode: str = "mock"

    def ping(self) -> str:
        return self.name

    def lookup_associate(self, document_id: str) -> dict[str, Any]:
        return {
            "ok": True,
            "mock_commercial": True,
            "mode": self.mode,
            "document_id": document_id,
            "associate": {
                "name": "Asociado Demo",
                "status": "activo",
                "product": "credito_educativo",
            },
            "note": "Pending EXTERNAL_BLOCKERS core API confirmation",
        }


core_adapter_service = CoreAdapterService()

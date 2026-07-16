"""core_adapter — HTTP real si CORE_BASE_URL; stub solo si mocks permitidos."""

from __future__ import annotations

from typing import Any

import httpx

from pilot_core.settings import get_settings


class CoreAdapterService:
    name: str = "core_adapter"

    def ping(self) -> str:
        return self.name

    @property
    def mode(self) -> str:
        return "live" if (get_settings().core_base_url or "").strip() else "mock"

    async def lookup_associate(self, document_id: str) -> dict[str, Any]:
        settings = get_settings()
        base = (settings.core_base_url or "").rstrip("/")
        if not base:
            if not settings.mocks_allowed():
                return {
                    "ok": False,
                    "mock_commercial": False,
                    "mode": "unconfigured",
                    "document_id": document_id,
                    "error": "CORE_BASE_URL required",
                }
            return {
                "ok": True,
                "mock_commercial": True,
                "mode": "mock",
                "document_id": document_id,
                "associate": {
                    "name": "Asociado Demo",
                    "status": "activo",
                    "product": "credito_educativo",
                    "cupo_preaprobado": True,
                },
                "note": "CORE_BASE_URL vacío — stub local",
            }

        token = (settings.core_api_token or "").strip()
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        path = (settings.core_associate_path or "/associates/{document_id}").replace(
            "{document_id}", document_id
        )
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(f"{base}{path}", headers=headers)
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text[:500]}
        return {
            "ok": resp.is_success,
            "mock_commercial": False,
            "mode": "live",
            "document_id": document_id,
            "http_status": resp.status_code,
            "associate": data,
        }


core_adapter_service = CoreAdapterService()

"""agent_config — Flujo A/B metadata for Ops (ElevenLabs IDs external)."""

from __future__ import annotations

from typing import Any

from pilot_core import ops_store

_DEFAULT = {
    "flujo_a": {
        "name": "Valerie Coopfuturo - Flujo A",
        "segment": "Renovacion",
        "agent_id": "",
        "phone_number_id": "",
        "channel": "voz",
    },
    "flujo_b": {
        "name": "Valerie Coopfuturo - Flujo B",
        "segment": "Reactivacion",
        "agent_id": "",
        "phone_number_id": "",
        "channel": "voz",
    },
    "whatsapp": {
        "provider": "liwa_mock",
        "mode": "mock",
        "note": "LIWA real blocked until credential rotation",
    },
}


class AgentConfigService:
    name: str = "agent_config"

    def ping(self) -> str:
        return self.name

    def get(self) -> dict[str, Any]:
        stored = ops_store.get_setting("agent_config")
        if isinstance(stored, dict):
            return {**_DEFAULT, **stored}
        return dict(_DEFAULT)

    def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        merged = {**self.get(), **payload}
        ops_store.set_setting("agent_config", merged)
        return merged


agent_config_service = AgentConfigService()

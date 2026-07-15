"""agent_config — Flujo A/B metadata for Ops (ElevenLabs IDs)."""

from __future__ import annotations

from typing import Any

from pilot_core import ops_store

# IDs from Hyperion ElevenLabs account — CoopFuturo SIP outbound (Telyaco).
# Nombres en dashboard 11labs: "Valerie Coopfuturo - Flujo A/B" (legado de naming);
# en PULSO los tratamos como agentes de Renovación / Reactivación.
_DEFAULT = {
    "flujo_a": {
        "name": "PULSO Renovación (Flujo A)",
        "segment": "Renovacion",
        "agent_id": "agent_8301kwgmehx0eh9r0rr1rbt3ttj3",
        "phone_number_id": "phnum_0201kwgmeny9ez1996k8rqgz2d5z",
        "from_number": "+573110899830",
        "channel": "voz",
        "provider": "elevenlabs_sip_trunk",
        "liwa_flow_id": "1782399915832",
        "liwa_handoff_tag": "RENOVACION_VIP",
        "crm_funnel": "Renovación",
    },
    "flujo_b": {
        "name": "PULSO Reactivación (Flujo B)",
        "segment": "Reactivacion",
        "agent_id": "agent_1401kwgmek4ff5hrkk6q27gvz7nd",
        "phone_number_id": "phnum_9301kwgmepyseqgb3ay8z48qz88d",
        "from_number": "+573110899801",
        "channel": "voz",
        "provider": "elevenlabs_sip_trunk",
        # Vacío: usa LIWA_FLOW_ID_B o cae al flujo Renovaciones hasta crear plantilla Reactivación.
        "liwa_flow_id": "",
        "liwa_handoff_tag": "REACTIVACION_VIP",
        "crm_funnel": "Reactivación",
    },
    "whatsapp": {
        "provider": "liwa",
        "mode": "pending_credentials",
        "note": "Usar credenciales LIWA proporcionadas por el cliente (sin rotación forzada).",
    },
}


class AgentConfigService:
    name: str = "agent_config"

    def ping(self) -> str:
        return self.name

    def get(self) -> dict[str, Any]:
        stored = ops_store.get_setting("agent_config")
        if isinstance(stored, dict):
            # Deep-merge top-level blocks so defaults fill empty IDs.
            out = dict(_DEFAULT)
            for k, v in stored.items():
                if isinstance(v, dict) and isinstance(out.get(k), dict):
                    out[k] = {**out[k], **v}
                else:
                    out[k] = v
            return out
        return dict(_DEFAULT)

    def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        merged = {**self.get(), **payload}
        ops_store.set_setting("agent_config", merged)
        return merged


agent_config_service = AgentConfigService()

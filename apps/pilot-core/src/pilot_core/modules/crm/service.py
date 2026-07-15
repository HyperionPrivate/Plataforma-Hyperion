"""CRM funnel state machine — move leads across columns + tipificaciones."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from pilot_core import ops_store

_FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "ops"

# Allowed transitions per funnel column (strict).
_TRANSITIONS: dict[str, list[str]] = {
    "pendiente": ["contactado", "no_interes"],
    "contactado": ["interesado", "pendiente", "no_interes"],
    "interesado": ["documento", "contactado", "no_interes"],
    "documento": ["transferido", "interesado", "no_interes"],
    "transferido": ["renovado", "documento", "no_interes"],
    "renovado": [],
    "no_interes": ["pendiente"],
}

_TIPIFICACION_REQUIRED = {"no_interes", "renovado"}


class CrmService:
    name: str = "crm"

    def ping(self) -> str:
        return self.name

    def _base(self) -> dict[str, Any]:
        return json.loads((_FIXTURES / "crm.json").read_text(encoding="utf-8"))

    def transitions(self) -> dict[str, list[str]]:
        return {k: list(v) for k, v in _TRANSITIONS.items()}

    def _find_fixture_card(self, lead_id: str) -> dict[str, Any] | None:
        data = self._base()
        for funnel_name, funnel in (data.get("funnels") or {}).items():
            for col in funnel.get("columns") or []:
                for card in col.get("cards") or []:
                    if card.get("id") == lead_id:
                        return {
                            **card,
                            "funnel": funnel_name,
                            "column_id": col["id"],
                            "tipificacion": None,
                        }
        return None

    def snapshot(self) -> dict[str, Any]:
        data = self._base()
        leads = ops_store.list_crm_leads()
        # Seed from contacts if no CRM leads yet.
        if not leads:
            for c in ops_store.list_contacts(30):
                funnel = "Renovación"
                seg = str(c.get("segment") or "").lower()
                if "reactiva" in seg:
                    funnel = "Reactivación"
                elif "micro" in seg:
                    funnel = "Microcrédito"
                elif "nuevo" in seg:
                    funnel = "Nuevos"
                lead = {
                    "id": c["id"],
                    "funnel": funnel,
                    "column_id": "pendiente",
                    "tipificacion": None,
                    "name": c.get("first_name") or "Lead",
                    "universidad": c.get("university") or "-",
                    "score": 70,
                    "channel": "voz",
                    "urgency": "alta",
                    "phone": c.get("phone"),
                }
                ops_store.upsert_crm_lead(lead)
            leads = ops_store.list_crm_leads()

        funnels = data.get("funnels") or {}
        for funnel_name, funnel in funnels.items():
            cols = funnel.get("columns") or []
            by_col: dict[str, list[dict[str, Any]]] = {c["id"]: [] for c in cols}
            tip_counts: dict[str, int] = {}
            for lead in leads:
                if lead.get("funnel") != funnel_name:
                    continue
                col = lead.get("column_id") or "pendiente"
                card = {
                    "id": lead["id"],
                    "name": lead.get("name") or "Lead",
                    "universidad": lead.get("universidad") or "-",
                    "score": lead.get("score") or 70,
                    "channel": lead.get("channel") or "voz",
                    "urgency": lead.get("urgency") or "media",
                    "phone": lead.get("phone"),
                    "allowed_next": _TRANSITIONS.get(col, []),
                }
                if col not in by_col:
                    by_col[col] = []
                by_col[col].append(card)
                tip = lead.get("tipificacion")
                if tip:
                    tip_counts[tip] = tip_counts.get(tip, 0) + 1
            new_cols = []
            for c in cols:
                stored = by_col.get(c["id"]) or []
                if stored:
                    cards = stored
                else:
                    # Fixture cards get allowed_next for UI.
                    cards = []
                    for card in c.get("cards") or []:
                        cards.append(
                            {
                                **card,
                                "allowed_next": _TRANSITIONS.get(c["id"], []),
                            }
                        )
                new_cols.append({**c, "cards": cards, "count": max(c.get("count", 0), len(cards))})
            funnel["columns"] = new_cols
            if tip_counts:
                funnel["tipificaciones"] = [
                    {"key": k, "label": k.replace("_", " ").title(), "count": v}
                    for k, v in tip_counts.items()
                ]
        data["transitions"] = self.transitions()
        data["tipificacion_required"] = sorted(_TIPIFICACION_REQUIRED)
        return data

    def move(
        self, *, lead_id: str, to_column: str, tipificacion: str | None = None
    ) -> dict[str, Any]:
        leads = {x["id"]: x for x in ops_store.list_crm_leads()}
        lead = leads.get(lead_id)
        if lead is None:
            fixture = self._find_fixture_card(lead_id)
            if fixture is None:
                raise ValueError(f"lead_not_found:{lead_id}")
            lead = fixture

        current = lead.get("column_id") or "pendiente"
        if to_column == current:
            return ops_store.upsert_crm_lead(lead)

        allowed = _TRANSITIONS.get(current, [])
        if to_column not in allowed:
            raise ValueError(
                f"transition_not_allowed:{current}->{to_column};allowed={','.join(allowed) or 'none'}"
            )

        if to_column in _TIPIFICACION_REQUIRED and not tipificacion:
            raise ValueError(f"tipificacion_required:{to_column}")

        lead["column_id"] = to_column
        if tipificacion:
            lead["tipificacion"] = tipificacion
        elif to_column == "documento" and not lead.get("tipificacion"):
            lead["tipificacion"] = "doc_solicitado"

        return ops_store.upsert_crm_lead(lead)

    def create_lead(
        self, *, name: str, funnel: str = "Renovación", phone: str | None = None
    ) -> dict[str, Any]:
        lead = {
            "id": f"crm_{uuid4().hex[:8]}",
            "funnel": funnel,
            "column_id": "pendiente",
            "tipificacion": None,
            "name": name,
            "universidad": "-",
            "score": 75,
            "channel": "voz",
            "urgency": "alta",
            "phone": phone,
        }
        return ops_store.upsert_crm_lead(lead)


crm_service = CrmService()

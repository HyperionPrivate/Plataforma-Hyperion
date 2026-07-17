"""CRM funnel state machine — move leads across columns + tipificaciones."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from pilot_core import ops_store

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

_COLUMN_DEFS: list[tuple[str, str]] = [
    ("pendiente", "Pendiente de contacto"),
    ("contactado", "Contactado"),
    ("interesado", "Interesado"),
    ("documento", "Documento recibido"),
    ("transferido", "Transferido a asesor"),
    ("renovado", "Renovado"),
    ("no_interes", "No interés"),
]

_FUNNEL_NAMES = ("Renovación", "Reactivación", "Nuevos", "Microcrédito")


class CrmService:
    name: str = "crm"

    def ping(self) -> str:
        return self.name

    def _base(self) -> dict[str, Any]:
        funnels: dict[str, Any] = {}
        for name in _FUNNEL_NAMES:
            funnels[name] = {
                "title": f"CRM — Funnel {name}",
                "columns": [
                    {"id": col_id, "label": label, "count": 0, "cards": []}
                    for col_id, label in _COLUMN_DEFS
                ],
                "tipificaciones": [],
            }
        return {"funnels": funnels}

    def transitions(self) -> dict[str, list[str]]:
        return {k: list(v) for k, v in _TRANSITIONS.items()}

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
                cards = by_col.get(c["id"]) or []
                new_cols.append({**c, "cards": cards, "count": len(cards)})
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
            raise ValueError(f"lead_not_found:{lead_id}")

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

    def find_by_phone(self, phone: str) -> dict[str, Any] | None:
        digits = "".join(ch for ch in (phone or "") if ch.isdigit())
        if not digits:
            return None
        for lead in ops_store.list_crm_leads():
            p = "".join(ch for ch in str(lead.get("phone") or "") if ch.isdigit())
            if p and p[-10:] == digits[-10:]:
                return lead
        return None

    def ensure_at_column(
        self,
        *,
        phone: str,
        to_column: str,
        name: str = "Asociado",
        funnel: str = "Renovación",
        tipificacion: str | None = None,
        channel: str = "whatsapp",
    ) -> dict[str, Any]:
        """Create/find lead by phone and walk the funnel to ``to_column`` (LIWA events)."""
        lead = self.find_by_phone(phone)
        if lead is None:
            lead = self.create_lead(name=name, funnel=funnel, phone=phone)
            lead["channel"] = channel
            lead = ops_store.upsert_crm_lead(lead)

        order = [c[0] for c in _COLUMN_DEFS]
        if to_column not in order:
            raise ValueError(f"unknown_column:{to_column}")

        # Short-circuit no_interes
        if to_column == "no_interes":
            current = lead.get("column_id") or "pendiente"
            if current == "no_interes":
                return lead
            # Force tipificacion path via allowed edges when possible
            tip = tipificacion or "opt_out_whatsapp"
            if "no_interes" in _TRANSITIONS.get(current, []):
                return self.move(lead_id=str(lead["id"]), to_column="no_interes", tipificacion=tip)
            lead["column_id"] = "no_interes"
            lead["tipificacion"] = tip
            return ops_store.upsert_crm_lead(lead)

        target_idx = order.index(to_column)
        current = lead.get("column_id") or "pendiente"
        if current not in order:
            current = "pendiente"
            lead["column_id"] = current
            lead = ops_store.upsert_crm_lead(lead)
        cur_idx = order.index(current)
        if cur_idx >= target_idx:
            return lead

        # Walk forward only along the happy path columns
        happy = ["pendiente", "contactado", "interesado", "documento", "transferido", "renovado"]
        for nxt in happy:
            if nxt not in order:
                continue
            if order.index(nxt) <= cur_idx:
                continue
            if order.index(nxt) > target_idx:
                break
            tip = tipificacion if nxt == to_column else None
            try:
                lead = self.move(lead_id=str(lead["id"]), to_column=nxt, tipificacion=tip)
                cur_idx = order.index(nxt)
            except ValueError:
                # Force if graph blocks (e.g. already no_interes)
                lead["column_id"] = nxt
                if tip:
                    lead["tipificacion"] = tip
                lead = ops_store.upsert_crm_lead(lead)
                cur_idx = order.index(nxt)
        return lead


crm_service = CrmService()

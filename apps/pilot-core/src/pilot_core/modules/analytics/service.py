"""analytics — KPIs derived from ops_store activity."""

from __future__ import annotations

from typing import Any

from pilot_core import ops_store


class AnalyticsService:
    name: str = "analytics"

    def ping(self) -> str:
        return self.name

    def overlay_dashboard(self, base: dict[str, Any]) -> dict[str, Any]:
        c = ops_store.counts()
        dispatches = ops_store.list_dispatches(100)
        voice = sum(
            1
            for d in dispatches
            if d.get("mode") in {"mock", "live"} and "whatsapp" not in str(d.get("mode"))
        )
        wa = sum(1 for d in dispatches if "whatsapp" in str(d.get("mode")))
        ops = list(base.get("ops") or [])
        # Replace first ops counters with live-ish values when we have activity.
        if c["dispatches"] or c["contacts"] or c["handoffs"]:
            live_ops = [
                {"id": "llamadas", "label": "Dispatches voz (demo)", "value": str(voice)},
                {"id": "wa", "label": "WhatsApps mock (demo)", "value": str(wa)},
                {"id": "contactos", "label": "Contactos en store", "value": str(c["contacts"])},
                {"id": "campanas", "label": "Campañas", "value": str(c["campaigns"])},
                {"id": "handoffs", "label": "Handoffs", "value": str(c["handoffs"])},
                {"id": "crm", "label": "Leads CRM", "value": str(c["crm_leads"])},
            ]
            # Keep remaining fixture ops for visual density.
            ops = [*live_ops, *[x for x in ops if x.get("id") not in {o["id"] for o in live_ops}]]
        return {**base, "ops": ops, "storeCounts": c}


analytics_service = AnalyticsService()

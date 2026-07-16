"""analytics — KPIs derived from ops_store activity (no smoke)."""

from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime
from typing import Any

from pilot_core import ops_store

_DAY_LABELS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]


def _is_whatsapp(d: dict[str, Any]) -> bool:
    mode = str(d.get("mode") or "").lower()
    channel = str(d.get("channel") or "").lower()
    if "whatsapp" in mode or channel == "whatsapp":
        return True
    return bool(isinstance(d.get("whatsapp"), dict))


def _is_voice(d: dict[str, Any]) -> bool:
    return not _is_whatsapp(d)


def _weekday_label(created_at: str | None) -> str:
    if not created_at:
        return _DAY_LABELS[datetime.now(UTC).weekday()]
    raw = created_at.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return _DAY_LABELS[datetime.now(UTC).weekday()]
    return _DAY_LABELS[dt.weekday()]


class AnalyticsService:
    name: str = "analytics"

    def ping(self) -> str:
        return self.name

    def overlay_dashboard(self, base: dict[str, Any]) -> dict[str, Any]:
        c = ops_store.counts()
        dispatches = ops_store.list_dispatches(500)
        voice = sum(1 for d in dispatches if _is_voice(d))
        wa = sum(1 for d in dispatches if _is_whatsapp(d))
        ok_voice = sum(
            1
            for d in dispatches
            if _is_voice(d)
            and str(d.get("status") or "") in {"sent", "queued_mock", "ok", "success"}
        )
        total = max(len(dispatches), 1)
        contact_rate = round(100 * (voice + wa) / total, 1) if dispatches else 0.0
        conv_rate = round(100 * ok_voice / max(voice, 1), 1) if voice else 0.0

        # contactsByDay from real dispatch timestamps
        by_day_voice: Counter[str] = Counter()
        by_day_wa: Counter[str] = Counter()
        for d in dispatches:
            label = _weekday_label(d.get("_created_at"))
            if _is_whatsapp(d):
                by_day_wa[label] += 1
            else:
                by_day_voice[label] += 1
        contacts_by_day = [
            {
                "date": day,
                "voz": by_day_voice.get(day, 0),
                "whatsapp": by_day_wa.get(day, 0),
            }
            for day in _DAY_LABELS
        ]

        crm_leads = c.get("crm_leads") or 0
        contacts = c.get("contacts") or 0
        handoffs = c.get("handoffs") or 0
        campaigns = c.get("campaigns") or 0

        contacted = voice + wa
        base_total = max(contacts, contacted, 1)
        failed_count = sum(1 for d in dispatches if d.get("status") == "failed")
        base_status = [
            {
                "key": "contactados",
                "label": "Contactados",
                "count": contacted,
                "pct": round(100 * contacted / base_total, 1),
                "color": "success",
            },
            {
                "key": "no_contactados",
                "label": "No contactados",
                "count": max(contacts - contacted, 0),
                "pct": round(100 * max(contacts - contacted, 0) / base_total, 1),
                "color": "muted",
            },
            {
                "key": "no_disponibles",
                "label": "No disponibles",
                "count": failed_count,
                "pct": round(100 * failed_count / base_total, 1) if failed_count else 0,
                "color": "warning",
            },
            {
                "key": "rechazados",
                "label": "Rechazados",
                "count": 0,
                "pct": 0,
                "color": "danger",
            },
            {
                "key": "otros",
                "label": "Otros",
                "count": handoffs,
                "pct": round(100 * handoffs / base_total, 1) if handoffs else 0,
                "color": "info",
            },
        ]

        funnel_counts = {
            "contactado": contacted,
            "interesado": crm_leads,
            "documento": max(crm_leads // 2, 0),
            "transferido": handoffs,
            "renovado": 0,
        }
        top = max(funnel_counts["contactado"], 1)
        funnel = [
            {
                "key": k,
                "label": label,
                "count": funnel_counts[k],
                "pct": round(100 * funnel_counts[k] / top, 1),
            }
            for k, label in [
                ("contactado", "Contactado"),
                ("interesado", "Interesado"),
                ("documento", "Documento"),
                ("transferido", "Transferido"),
                ("renovado", "Renovado"),
            ]
        ]

        spark = [0, 0, 0, 0, 0, 0, contact_rate]
        kpis = [
            {
                "id": "contactabilidad",
                "label": "Contactabilidad",
                "value": contact_rate,
                "unit": "%",
                "delta": 0,
                "deltaUnit": "pp",
                "sparkline": spark,
            },
            {
                "id": "conversacion",
                "label": "Conversación completada",
                "value": conv_rate,
                "unit": "%",
                "delta": 0,
                "deltaUnit": "pp",
                "sparkline": [0, 0, 0, 0, 0, 0, conv_rate],
            },
            {
                "id": "intencion",
                "label": "Intención positiva",
                "value": round(100 * crm_leads / max(contacted, 1), 1) if contacted else 0,
                "unit": "%",
                "delta": 0,
                "deltaUnit": "pp",
                "sparkline": [0, 0, 0, 0, 0, 0, 0],
            },
            {
                "id": "ordenes",
                "label": "Órdenes / leads CRM",
                "value": crm_leads,
                "unit": "",
                "delta": 0,
                "deltaUnit": "%",
                "sparkline": [0, 0, 0, 0, 0, 0, crm_leads],
            },
            {
                "id": "csat",
                "label": "CSAT",
                "value": 0,
                "unit": "/5",
                "delta": 0,
                "deltaUnit": "",
                "sparkline": [0, 0, 0, 0, 0, 0, 0],
            },
        ]

        ops = [
            {"id": "llamadas", "label": "Dispatches voz", "value": str(voice)},
            {"id": "wa", "label": "WhatsApp", "value": str(wa)},
            {"id": "contactos", "label": "Contactos en store", "value": str(contacts)},
            {"id": "campanas", "label": "Campañas", "value": str(campaigns)},
            {"id": "handoffs", "label": "Handoffs", "value": str(handoffs)},
            {"id": "crm", "label": "Leads CRM", "value": str(crm_leads)},
        ]

        live_events = list(base.get("liveEvents") or [])
        if not live_events and dispatches:
            for d in dispatches[:12]:
                lead = d.get("lead") or {}
                live_events.append(
                    {
                        "id": d.get("id"),
                        "channel": "whatsapp" if _is_whatsapp(d) else "voz",
                        "personName": lead.get("first_name") or lead.get("phone") or "Lead",
                        "kind": "WhatsApp enviado" if _is_whatsapp(d) else "Llamada enviada",
                        "at": "ahora",
                    }
                )

        return {
            **base,
            "kpis": kpis,
            "contactsByDay": contacts_by_day,
            "funnelRenovacion": funnel,
            "baseStatus": base_status,
            "ops": ops,
            "liveEvents": live_events,
            "storeCounts": c,
        }


analytics_service = AnalyticsService()

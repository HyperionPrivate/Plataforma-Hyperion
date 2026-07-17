"""LIWA WhatsApp client — chat.liwa.co API (X-ACCESS-TOKEN)."""

from __future__ import annotations

from typing import Any, cast
from uuid import uuid4

import httpx

from pilot_core import ops_store
from pilot_core.modules.activity import record_outbound_conversation
from pilot_core.settings import get_settings


def _base_url() -> str:
    return (get_settings().liwa_base_url or "https://chat.liwa.co/api").rstrip("/")


def _headers() -> dict[str, str]:
    token = (get_settings().liwa_api_token or "").strip()
    return {
        "X-ACCESS-TOKEN": token,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _extract_contact_id(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    for key in ("id", "contact_id", "user_id"):
        val = payload.get(key)
        if val is not None and str(val).strip():
            return str(val)
    data = payload.get("data")
    if isinstance(data, dict):
        return _extract_contact_id(data)
    contact = payload.get("contact")
    if isinstance(contact, dict):
        return _extract_contact_id(contact)
    return None


def _extract_receipt_id(payload: Any) -> str | None:
    """Provider message / delivery id — required to declare WhatsApp 'sent' (AUD-016)."""
    if not isinstance(payload, dict):
        return None
    for key in ("message_id", "messageId", "wa_message_id", "provider_message_id", "id"):
        val = payload.get(key)
        if val is not None and str(val).strip() and key != "id":
            return str(val).strip()
        # bare "id" only if it looks like a message id (not a boolean/contact echo)
        if key == "id" and val is not None:
            s = str(val).strip()
            if s and s.lower() not in {"true", "false", "none"} and len(s) >= 6:
                return s
    for nested_key in ("data", "message", "result"):
        nested = payload.get(nested_key)
        found = _extract_receipt_id(nested)
        if found:
            return found
    return None


# Preview copy for Renovaciones when LIWA send/flow returns no message body.
_RENOVACIONES_FLOW_PREVIEW = (
    "🚨 Estimado estudiante, tienes un cupo de crédito preaprobado. "
    "Asegura hoy tu próximo semestre y sigue construyendo tu futuro con el respaldo de Coopfuturo. "
    "Renueva tu crédito educativo de manera ágil, segura y sin salir de casa antes del 30 de junio "
    "y participa en el sorteo de: ✅ Becas educativas y ✅ Auxilios para matrícula. "
    "Tu próximo semestre te espera. Aprovecha esta oportunidad. "
    "📩 Envía tu recibo y asegura hoy tu financiación con Coopfuturo."
)


def _flow_inbox_snippet(*, flow_id: str, text: str) -> str:
    """Text shown in Conversaciones for outbound flow (LIWA does not return body)."""
    t = (text or "").strip()
    if t:
        return t
    fid = (flow_id or "").strip()
    default_fid = (get_settings().liwa_default_flow_id or "1782399915832").strip()
    if fid in {default_fid, "1782399915832"}:
        return _RENOVACIONES_FLOW_PREVIEW
    return f"Flujo WhatsApp enviado ({fid})" if fid else "Flujo WhatsApp enviado"


def _audit(
    *,
    phone: str,
    first_name: str,
    entry: dict[str, Any],
) -> None:
    ops_store.insert_dispatch(
        {
            "id": entry["id"],
            "mode": "whatsapp_liwa",
            "status": entry.get("status") or "unknown",
            "lead": {"phone": phone, "first_name": first_name},
            "whatsapp": entry,
        }
    )
    if str(entry.get("kind") or "") == "flow":
        snippet = _flow_inbox_snippet(
            flow_id=str(entry.get("flow_id") or ""),
            text=str(entry.get("text") or ""),
        )
    else:
        snippet = str(entry.get("text") or "").strip() or "Mensaje WhatsApp enviado"
    record_outbound_conversation(
        phone=phone,
        first_name=first_name or "Asociado",
        channel="whatsapp",
        snippet=snippet[:160],
        topic="WhatsApp",
    )


class LiwaWhatsAppService:
    name: str = "liwa_whatsapp"
    mode: str = "real"

    async def accounts_me(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(f"{_base_url()}/accounts/me", headers=_headers())
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text[:500]}
        return {
            "ok": resp.is_success,
            "http_status": resp.status_code,
            "account": data,
        }

    async def list_flows(self) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(f"{_base_url()}/accounts/flows", headers=_headers())
        try:
            data = resp.json()
        except Exception:
            data = []
        items = data if isinstance(data, list) else []
        return {
            "ok": resp.is_success,
            "http_status": resp.status_code,
            "items": items,
            "default_flow_id": get_settings().liwa_default_flow_id,
        }

    async def ensure_contact(
        self,
        *,
        phone: str,
        first_name: str = "Asociado",
    ) -> dict[str, Any]:
        body = {
            "phone": phone,
            "first_name": first_name,
        }
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{_base_url()}/contacts",
                headers=_headers(),
                json=body,
            )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text[:800]}
        contact_id = _extract_contact_id(data)
        if not contact_id and isinstance(data, dict):
            # LIWA a veces responde success + data.id cuando el contacto ya existe.
            nested = data.get("data")
            if isinstance(nested, dict):
                contact_id = _extract_contact_id(nested)
        return {
            "ok": resp.is_success and bool(contact_id),
            "http_status": resp.status_code,
            "contact_id": contact_id,
            "response": data,
        }

    async def send_text(
        self,
        *,
        phone: str,
        text: str,
        first_name: str = "Asociado",
        template: str | None = None,
    ) -> dict[str, Any]:
        """Texto libre: solo fiable dentro de ventana 24h WhatsApp."""
        created = await self.ensure_contact(phone=phone, first_name=first_name)
        if not created.get("ok") or not created.get("contact_id"):
            entry = {
                "id": f"wa_{uuid4().hex[:10]}",
                "channel": "whatsapp",
                "mode": self.mode,
                "kind": "text",
                "status": "failed",
                "to": phone,
                "text": text[:500],
                "template": template,
                "provider": "liwa",
                "error": "contact_create_failed",
                "provider_response": created,
            }
            _audit(phone=phone, first_name=first_name, entry=entry)
            return {
                "ok": False,
                "mock_commercial": False,
                "message": entry,
                "error": "liwa_contact_create_failed",
            }

        contact_id = str(created["contact_id"])
        payload = {"text": text, "channel": "whatsapp"}
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{_base_url()}/contacts/{contact_id}/send/text",
                headers=_headers(),
                json=payload,
            )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text[:800]}

        receipt = _extract_receipt_id(data) if resp.is_success else None
        if resp.is_success and receipt:
            status = "sent"
        elif resp.is_success:
            status = "accepted_pending"
        else:
            status = "failed"
        entry = cast(
            dict[str, Any],
            {
                "id": f"wa_{uuid4().hex[:10]}",
                "channel": "whatsapp",
                "mode": self.mode,
                "kind": "text",
                "status": status,
                "receipt_id": receipt,
                "to": phone,
                "text": text[:500],
                "template": template,
                "provider": "liwa",
                "contact_id": contact_id,
                "http_status": resp.status_code,
                "provider_response": data,
            },
        )
        _audit(phone=phone, first_name=first_name, entry=entry)
        # Align with send_flow: LIWA often returns HTTP 200 without receipt_id
        # (accepted_pending). Treating that as ok=false caused Conversaciones
        # reply to raise 502 even though WhatsApp delivered.
        return {
            "ok": status in {"sent", "accepted_pending"},
            "mock_commercial": False,
            "message": entry,
            "delivery": status,
        }

    async def send_flow(
        self,
        *,
        phone: str,
        flow_id: str | None = None,
        first_name: str = "Asociado",
        text: str | None = None,
    ) -> dict[str, Any]:
        """Dispara un flujo LIWA (debe contener plantilla WA para outbound frío).

        Importante: ``POST /contacts`` con ``actions.send_flow`` solo dispara el
        flujo cuando el contacto es nuevo. Si ya existe, LIWA responde
        ``success=true, contact_created=false`` y **no** envía el WA. Por eso
        siempre hacemos ``POST /contacts/{id}/send/{flow_id}`` después.
        """
        fid = (flow_id or get_settings().liwa_default_flow_id or "").strip()
        if not fid:
            return {
                "ok": False,
                "mock_commercial": False,
                "error": "liwa_flow_id_missing",
                "message": {"error": "liwa_flow_id_missing"},
            }

        created = await self.ensure_contact(phone=phone, first_name=first_name)
        contact_id = created.get("contact_id")
        if not contact_id:
            entry = {
                "id": f"wa_{uuid4().hex[:10]}",
                "channel": "whatsapp",
                "mode": self.mode,
                "kind": "flow",
                "status": "failed",
                "to": phone,
                "text": (text or "")[:500],
                "flow_id": fid,
                "provider": "liwa",
                "error": "contact_create_failed",
                "provider_response": created,
            }
            _audit(phone=phone, first_name=first_name, entry=entry)
            return {
                "ok": False,
                "mock_commercial": False,
                "message": entry,
                "error": "liwa_contact_create_failed",
            }

        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.post(
                f"{_base_url()}/contacts/{contact_id}/send/{fid}",
                headers=_headers(),
            )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text[:800]}

        success_flag = True
        if isinstance(data, dict) and "success" in data:
            success_flag = bool(data.get("success"))
        receipt = _extract_receipt_id(data) if resp.is_success and success_flag else None
        # AUD-016: 200 {} without receipt is not "sent".
        if resp.is_success and success_flag and receipt:
            status = "sent"
        elif resp.is_success and success_flag:
            status = "accepted_pending"
        else:
            status = "failed"
        preview = _flow_inbox_snippet(flow_id=fid, text=text or "")
        entry = cast(
            dict[str, Any],
            {
                "id": f"wa_{uuid4().hex[:10]}",
                "channel": "whatsapp",
                "mode": self.mode,
                "kind": "flow",
                "status": status,
                "receipt_id": receipt,
                "to": phone,
                "text": preview[:500],
                "flow_id": fid,
                "provider": "liwa",
                "contact_id": str(contact_id),
                "http_status": resp.status_code,
                "provider_response": {
                    "ensure_contact": created,
                    "send_flow": data,
                },
            },
        )
        _audit(phone=phone, first_name=first_name, entry=entry)
        # LIWA frequently returns success without message_id → accepted_pending.
        # That still means the flow was accepted; only hard failures set ok=False.
        return {
            "ok": status in {"sent", "accepted_pending"},
            "mock_commercial": False,
            "message": entry,
            "delivery": status,
        }

    async def list_tags(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(f"{_base_url()}/accounts/tags", headers=_headers())
        data = resp.json() if resp.is_success else []
        return data if isinstance(data, list) else []

    async def ensure_tag(self, name: str) -> dict[str, Any]:
        tags = await self.list_tags()
        for t in tags:
            if str(t.get("name") or "").upper() == name.upper():
                return {"ok": True, "tag": t, "created": False}
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{_base_url()}/accounts/tags",
                headers=_headers(),
                json={"name": name},
            )
        try:
            data = resp.json()
        except Exception:
            data = {}
        tag = data if isinstance(data, dict) else {}
        if not tag.get("id"):
            # re-list
            tags = await self.list_tags()
            for t in tags:
                if str(t.get("name") or "").upper() == name.upper():
                    return {"ok": True, "tag": t, "created": True}
        return {"ok": resp.is_success and bool(tag.get("id")), "tag": tag, "created": True}

    async def add_tag(self, contact_id: str, tag_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{_base_url()}/contacts/{contact_id}/tags/{tag_id}",
                headers=_headers(),
            )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text[:400]}
        return {"ok": resp.is_success, "http_status": resp.status_code, "response": data}

    async def handoff_to_agency(
        self,
        *,
        phone: str,
        first_name: str,
        motivo: str,
        tag_name: str | None = None,
    ) -> dict[str, Any]:
        """Tag contact for agency queue + short note via text (best-effort)."""
        tag_name = (tag_name or get_settings().liwa_handoff_tag or "RENOVACION_VIP").strip()
        created = await self.ensure_contact(phone=phone, first_name=first_name)
        if not created.get("contact_id"):
            return {"ok": False, "error": "contact_create_failed", "detail": created}
        contact_id = str(created["contact_id"])
        tag_res = await self.ensure_tag(tag_name)
        tag = tag_res.get("tag") or {}
        tag_id = str(tag.get("id") or "")
        add = {"ok": False}
        if tag_id:
            add = await self.add_tag(contact_id, tag_id)
        # Best-effort note in chat (may not deliver outside 24h).
        note = await self.send_text(
            phone=phone,
            text=f"[HANDOFF PULSO] {motivo}",
            first_name=first_name,
        )
        return {
            "ok": bool(add.get("ok")),
            "contact_id": contact_id,
            "tag_name": tag_name,
            "tag_id": tag_id or None,
            "tag_result": add,
            "note_result": {"ok": note.get("ok"), "id": (note.get("message") or {}).get("id")},
        }

    async def get_contact(self, contact_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{_base_url()}/contacts/{contact_id}",
                headers=_headers(),
            )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text[:500]}
        return {
            "ok": resp.is_success and isinstance(data, dict) and not data.get("error"),
            "http_status": resp.status_code,
            "contact": data if isinstance(data, dict) else {},
        }

    async def get_contact_tags(self, contact_id: str) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{_base_url()}/contacts/{contact_id}/tags",
                headers=_headers(),
            )
        if not resp.is_success:
            return []
        try:
            data = resp.json()
        except Exception:
            return []
        return data if isinstance(data, list) else []

    async def get_contact_handoff_state(
        self,
        *,
        phone: str,
        first_name: str = "Asociado",
    ) -> dict[str, Any]:
        """Poll LIWA contact live_chat + tags (demo bridge without inbound webhooks)."""
        if not get_settings().liwa_live_enabled():
            return {
                "ok": False,
                "error": "liwa_not_live",
                "live_chat": False,
                "tags": [],
                "handoff_detected": False,
            }
        created = await self.ensure_contact(phone=phone, first_name=first_name)
        contact_id = created.get("contact_id")
        if not contact_id:
            return {
                "ok": False,
                "error": "contact_not_found",
                "live_chat": False,
                "tags": [],
                "handoff_detected": False,
                "provider": created,
            }
        cid = str(contact_id)
        fetched = await self.get_contact(cid)
        contact = fetched.get("contact") or {}
        live_chat = bool(contact.get("live_chat"))
        tag_rows = await self.get_contact_tags(cid)
        tag_names = [
            str(t.get("name") or "").strip()
            for t in tag_rows
            if isinstance(t, dict) and str(t.get("name") or "").strip()
        ]
        handoff_tags = [n for n in tag_names if is_handoff_tag(n)]
        agency_hint = agency_hint_from_tags(tag_names)
        handoff_detected = live_chat or bool(handoff_tags)
        page_id = str(contact.get("page_id") or contact.get("account_id") or "1656233")
        inbox_url = f"https://chat.liwa.co/?acc={page_id}"
        return {
            "ok": bool(fetched.get("ok")),
            "contact_id": cid,
            "phone": phone,
            "live_chat": live_chat,
            "tags": tag_names,
            "handoff_tags": handoff_tags,
            "agency_hint": agency_hint,
            "handoff_detected": handoff_detected,
            "inbox_url": inbox_url,
            "page_id": page_id,
            "mode": "bot" if not handoff_detected else "live_chat",
        }

    async def send(
        self,
        *,
        phone: str,
        text: str = "",
        first_name: str = "Asociado",
        template: str | None = None,
        kind: str = "flow",
        flow_id: str | None = None,
    ) -> dict[str, Any]:
        """kind=flow (recomendado outbound) | text (solo ventana 24h)."""
        if str(kind).lower() == "text":
            return await self.send_text(
                phone=phone, text=text or " ", first_name=first_name, template=template
            )
        return await self.send_flow(
            phone=phone,
            flow_id=flow_id,
            first_name=first_name,
            text=text,
        )


# Tag fragment → sede label (Renovaciones campaign tags + AG_*).
_SEDE_HINTS: dict[str, str] = {
    "PIEDE": "Piedecuesta",
    "PIEDECUESTA": "Piedecuesta",
    "BARRANQUILLA": "Barranquilla",
    "BQUILLA": "Barranquilla",
    "BUCARAMANGA": "Bucaramanga",
    "CUCUTA": "Cúcuta",
    "FLORIDABLANCA": "Floridablanca",
    "FLOR": "Floridablanca",
    "SAN_GIL": "San Gil",
    "SANGIL": "San Gil",
    "VALLEDUPAR": "Valledupar",
    "VILLAVICENCIO": "Villavicencio",
    "VILLAVO": "Villavicencio",
    "BARRANCABERMEJA": "Barrancabermeja",
}


def agency_hint_from_tags(tag_names: list[str]) -> str | None:
    """Best-effort sede from LIWA tags like RENOVACION_PIEDE_25062026 or AG_BARRANQUILLA."""
    for raw in tag_names:
        name = str(raw or "").strip().upper()
        if not name:
            continue
        if name.startswith("AG_"):
            key = name[3:].replace(" ", "_")
            if key in _SEDE_HINTS:
                return _SEDE_HINTS[key]
            return key.replace("_", " ").title()
        for key, label in _SEDE_HINTS.items():
            if key in name:
                return label
    return None


def is_handoff_tag(name: str) -> bool:
    n = str(name or "").strip().upper()
    return n.startswith("AG_") or n.startswith("RENOVACION_") or n.startswith("REACTIVACION_")


liwa_whatsapp_service = LiwaWhatsAppService()

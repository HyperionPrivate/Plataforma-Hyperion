"""LIWA WhatsApp client — chat.liwa.co API (X-ACCESS-TOKEN)."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import httpx

from pilot_core import ops_store
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

        status = "sent" if resp.is_success else "failed"
        entry = {
            "id": f"wa_{uuid4().hex[:10]}",
            "channel": "whatsapp",
            "mode": self.mode,
            "kind": "text",
            "status": status,
            "to": phone,
            "text": text[:500],
            "template": template,
            "provider": "liwa",
            "contact_id": contact_id,
            "http_status": resp.status_code,
            "provider_response": data,
        }
        _audit(phone=phone, first_name=first_name, entry=entry)
        return {
            "ok": resp.is_success,
            "mock_commercial": False,
            "message": entry,
        }

    async def send_flow(
        self,
        *,
        phone: str,
        flow_id: str | None = None,
        first_name: str = "Asociado",
        text: str | None = None,
    ) -> dict[str, Any]:
        """Dispara un flujo LIWA (debe contener plantilla WA para outbound frío)."""
        fid = (flow_id or get_settings().liwa_default_flow_id or "").strip()
        if not fid:
            return {
                "ok": False,
                "mock_commercial": False,
                "error": "liwa_flow_id_missing",
                "message": {"error": "liwa_flow_id_missing"},
            }

        # Prefer create+action send_flow (abre contacto y dispara en un paso).
        create_body: dict[str, Any] = {
            "phone": phone,
            "first_name": first_name,
            "actions": [{"action": "send_flow", "flow_id": int(fid) if fid.isdigit() else fid}],
        }
        async with httpx.AsyncClient(timeout=45.0) as client:
            resp = await client.post(
                f"{_base_url()}/contacts",
                headers=_headers(),
                json=create_body,
            )
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text[:800]}

        contact_id = _extract_contact_id(data)
        if not contact_id and isinstance(data, dict):
            nested = data.get("data")
            if isinstance(nested, dict):
                contact_id = _extract_contact_id(nested)

        # Fallback: ensure contact then POST /send/{flow_id}
        if not contact_id or not resp.is_success:
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
                    "provider_response": {"create": data, "ensure": created},
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

        ok = resp.is_success and bool(
            data.get("success", True) if isinstance(data, dict) else True
        )
        entry = {
            "id": f"wa_{uuid4().hex[:10]}",
            "channel": "whatsapp",
            "mode": self.mode,
            "kind": "flow",
            "status": "sent" if ok else "failed",
            "to": phone,
            "text": (text or "")[:500],
            "flow_id": fid,
            "provider": "liwa",
            "contact_id": str(contact_id) if contact_id else None,
            "http_status": resp.status_code,
            "provider_response": data,
        }
        _audit(phone=phone, first_name=first_name, entry=entry)
        return {
            "ok": ok,
            "mock_commercial": False,
            "message": entry,
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


liwa_whatsapp_service = LiwaWhatsAppService()

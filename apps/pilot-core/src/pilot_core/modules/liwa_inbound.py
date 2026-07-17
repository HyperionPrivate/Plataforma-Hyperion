"""Normalize LIWA → PULSO webhook events (messages, handoff, CSAT, opt-out, documents, CRM)."""

from __future__ import annotations

import re
import unicodedata
from typing import Any
from uuid import uuid4

from pilot_core import ops_store
from pilot_core.modules.activity import conversation_id_for_phone, record_outbound_conversation
from pilot_core.modules.compliance.service import compliance_service
from pilot_core.modules.crm.service import crm_service
from pilot_core.phone import normalize_phone

_OPT_OUT_RE = re.compile(
    r"\b(stop|parar|cancelar|opt[\s-]?out|no\s+me\s+contacten|fuera\s+de\s+lista|"
    r"no\s+llamar|eliminar\s+datos)\b",
    re.I,
)

# Plan LIWA UI events → internal
_EVENT_ALIASES: dict[str, str] = {
    "msg": "message",
    "inbound": "message",
    "user_message": "message",
    "mensaje": "message",
    "bot_message": "bot_message",
    "bot_msg": "bot_message",
    "outbound_message": "bot_message",
    "agent_message": "bot_message",
    "transfer": "handoff",
    "agencia": "handoff",
    "agency": "handoff",
    "handoff_requested": "handoff",
    "survey": "csat",
    "satisfaction": "csat",
    "nps": "csat",
    "optout": "opt_out",
    "unsubscribe": "opt_out",
    "exclusion": "opt_out",
    "file": "document",
    "pdf": "document",
    "attachment": "document",
    "documento": "document",
    "document_received": "document",
    "prequal_completed": "prequal",
    "prequal": "prequal",
    "precalificacion": "prequal",
}

_CITY_TO_AG: dict[str, str] = {
    "barranquilla": "AG_BARRANQUILLA",
    "bucaramanga": "AG_BUCARAMANGA",
    "cucuta": "AG_CUCUTA",
    "cúcuta": "AG_CUCUTA",
    "floridablanca": "AG_FLORIDABLANCA",
    "piedecuesta": "AG_PIEDECUESTA",
    "san gil": "AG_SAN GIL",
    "sangil": "AG_SAN GIL",
    "valledupar": "AG_VALLEDUPAR",
    "villavicencio": "AG_VILLAVICENCIO",
    "barrancabermeja": "AG_BARRANCABERMEJA",
}


def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def agency_tag_from_ciudad(ciudad: str | None, explicit: str | None = None) -> str | None:
    if explicit and str(explicit).strip():
        tag = str(explicit).strip()
        if not tag.upper().startswith("AG_"):
            tag = f"AG_{tag.upper().replace(' ', '_')}"
        return tag
    if not ciudad:
        return None
    key = _strip_accents(ciudad.strip().lower())
    if key in _CITY_TO_AG:
        return _CITY_TO_AG[key]
    # fuzzy: first token
    for city, tag in _CITY_TO_AG.items():
        if city in key or key in city:
            return tag
    return None


def _pick_str(payload: dict[str, Any], *keys: str) -> str:
    for key in keys:
        val = payload.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    data = payload.get("data")
    if isinstance(data, dict):
        for key in keys:
            val = data.get(key)
            if val is not None and str(val).strip():
                return str(val).strip()
    contact = payload.get("contact")
    if isinstance(contact, dict):
        for key in keys:
            val = contact.get(key)
            if val is not None and str(val).strip():
                return str(val).strip()
        custom = contact.get("custom")
        if isinstance(custom, dict):
            for key in keys:
                val = custom.get(key)
                if val is not None and str(val).strip():
                    return str(val).strip()
    return ""


def normalize_liwa_webhook(payload: dict[str, Any]) -> dict[str, Any]:
    """Map LIWA / API-externa payloads into a stable internal event."""
    event = (_pick_str(payload, "event", "type", "trigger") or "message").lower()
    event = _EVENT_ALIASES.get(event, event)

    phone_raw = _pick_str(payload, "phone", "telefono", "whatsapp", "msisdn", "mobile")
    phone = normalize_phone(phone_raw) or phone_raw
    text = _pick_str(payload, "text", "message", "body", "mensaje", "content")
    first_name = _pick_str(payload, "first_name", "nombre", "name") or "Asociado"
    contact_id = _pick_str(payload, "contact_id", "external_id")
    ciudad = _pick_str(payload, "ciudad", "city", "agencia_ciudad")
    agency_explicit = _pick_str(payload, "agency_tag", "tag", "tag_name", "agencia")
    agency_tag = agency_tag_from_ciudad(ciudad, agency_explicit or None)
    file_url = _pick_str(payload, "file_url", "url", "document_url", "media_url")
    file_name = _pick_str(payload, "file_name", "filename", "document_name") or "documento.pdf"

    csat_raw = payload.get("csat")
    if csat_raw is None:
        csat_raw = payload.get("score")
    if csat_raw is None and isinstance(payload.get("data"), dict):
        csat_raw = payload["data"].get("csat") or payload["data"].get("score")
    csat: int | None = None
    if csat_raw is not None:
        try:
            n = int(csat_raw)
            if 1 <= n <= 5:
                csat = n
        except (TypeError, ValueError):
            csat = None

    if event == "message" and text and _OPT_OUT_RE.search(text):
        event = "opt_out"

    tenant_id = _pick_str(payload, "tenant_id", "tenant") or ""
    role_hint = (_pick_str(payload, "role", "direction", "from", "sender") or "").lower()
    # LIWA bot / flow outbound → Conversaciones bubble as role=bot
    if event == "bot_message" or role_hint in {
        "bot",
        "agent",
        "advisor",
        "asesor",
        "outbound",
        "system",
    }:
        msg_role = "bot"
        if event == "message":
            event = "bot_message"
    else:
        msg_role = "user"

    return {
        "event": event,
        "phone": phone,
        "first_name": first_name,
        "text": text,
        "contact_id": contact_id or None,
        "agency_tag": agency_tag,
        "ciudad": ciudad or None,
        "csat": csat,
        "file_url": file_url or None,
        "file_name": file_name,
        "tenant_id": tenant_id or None,
        "msg_role": msg_role,
    }


def _find_thread_by_phone(phone: str) -> dict[str, Any] | None:
    digits = re.sub(r"\D", "", phone or "")
    if not digits:
        return None
    for t in ops_store.list_conversation_threads():
        exp = t.get("expediente") or {}
        exp_digits = re.sub(r"\D", "", str(exp.get("phone") or ""))
        if exp_digits and exp_digits[-10:] == digits[-10:]:
            return t
        tid = str(t.get("id") or "")
        if tid == conversation_id_for_phone(phone):
            return t
    return None


def _ensure_thread(
    *,
    phone: str,
    first_name: str,
    snippet: str,
    agency_tag: str | None = None,
) -> dict[str, Any]:
    existing = _find_thread_by_phone(phone)
    if existing:
        tags = list(existing.get("tags") or [])
        if "WhatsApp" not in tags:
            tags = ["WhatsApp", *tags]
        if agency_tag and agency_tag not in tags:
            tags = [agency_tag, *tags]
        thread = {
            **existing,
            "name": first_name or existing.get("name") or "Asociado",
            "snippet": (snippet or existing.get("snippet") or "")[:160],
            "channel": "whatsapp",
            "tags": tags,
            "expediente": {
                **(existing.get("expediente") or {}),
                "phone": phone,
            },
        }
        return ops_store.upsert_conversation_thread(thread)
    return record_outbound_conversation(
        phone=phone,
        first_name=first_name,
        channel="whatsapp",
        snippet=snippet or "WhatsApp inbound",
        topic="WhatsApp",
        message_role="user",
    )


def _crm_to(
    *,
    phone: str,
    column: str,
    name: str,
    tipificacion: str | None = None,
) -> dict[str, Any] | None:
    try:
        return crm_service.ensure_at_column(
            phone=phone,
            to_column=column,
            name=name,
            tipificacion=tipificacion,
            channel="whatsapp",
        )
    except Exception:
        # Never return exception text to webhook/Lab clients (CodeQL py/stack-trace-exposure).
        return {"error": "crm_update_failed"}


def record_csat(score: int, *, phone: str | None = None) -> dict[str, Any]:
    raw = ops_store.get_setting("csat_samples") or []
    samples = list(raw) if isinstance(raw, list) else []
    entry = {"score": score, "phone": phone, "id": f"csat_{uuid4().hex[:8]}"}
    samples.append(entry)
    samples = samples[-500:]
    ops_store.set_setting("csat_samples", samples)
    return entry


def csat_average() -> float:
    raw = ops_store.get_setting("csat_samples") or []
    if not isinstance(raw, list) or not raw:
        return 0.0
    scores = [int(x["score"]) for x in raw if isinstance(x, dict) and x.get("score")]
    if not scores:
        return 0.0
    return round(sum(scores) / len(scores), 1)


async def process_liwa_inbound(payload: dict[str, Any]) -> dict[str, Any]:
    """Apply a normalized LIWA event to Ops store. Caller sets tenant ContextVar."""
    n = normalize_liwa_webhook(payload)
    phone = n["phone"]
    if not phone:
        return {"ok": False, "error": "phone_required", "normalized": n}

    event = n["event"]
    actions: list[str] = []
    crm_lead: dict[str, Any] | None = None

    if event == "opt_out":
        compliance_service.suppress(phone)
        actions.append("opt_out")
        crm_lead = _crm_to(
            phone=phone,
            column="no_interes",
            name=n["first_name"],
            tipificacion="opt_out_whatsapp",
        )
        actions.append("crm_no_interes")
        _ensure_thread(phone=phone, first_name=n["first_name"], snippet=n["text"] or "Opt-out")
        if n["text"]:
            thread = _find_thread_by_phone(phone)
            cid = str(thread["id"]) if thread else conversation_id_for_phone(phone)
            ops_store.append_conversation_message(
                cid,
                {
                    "id": f"m_{uuid4().hex[:10]}",
                    "role": "user",
                    "text": n["text"][:500],
                    "at": "ahora",
                    "source": "liwa_inbound",
                },
            )
        return {
            "ok": True,
            "event": event,
            "phone": phone,
            "actions": actions,
            "crm": crm_lead,
            "normalized": n,
        }

    if event == "csat":
        if n["csat"] is not None:
            record_csat(int(n["csat"]), phone=phone)
            actions.append("csat_recorded")
        _ensure_thread(
            phone=phone,
            first_name=n["first_name"],
            snippet=f"CSAT {n['csat']}" if n["csat"] else "CSAT",
        )
        return {"ok": True, "event": "csat", "phone": phone, "actions": actions, "normalized": n}

    if event == "prequal":
        thread = _ensure_thread(
            phone=phone,
            first_name=n["first_name"],
            snippet=n["text"] or "Precalificación completa",
            agency_tag=n["agency_tag"],
        )
        crm_lead = _crm_to(phone=phone, column="interesado", name=n["first_name"])
        actions.append("crm_interesado")
        if n["text"]:
            ops_store.append_conversation_message(
                str(thread["id"]),
                {
                    "id": f"m_{uuid4().hex[:10]}",
                    "role": "user",
                    "text": n["text"][:500],
                    "at": "ahora",
                    "source": "liwa_prequal",
                },
            )
        return {
            "ok": True,
            "event": "prequal",
            "phone": phone,
            "conversation_id": thread["id"],
            "actions": actions,
            "crm": crm_lead,
            "normalized": n,
        }

    thread = _ensure_thread(
        phone=phone,
        first_name=n["first_name"],
        snippet=n["text"] or n["file_name"] or "WhatsApp",
        agency_tag=n["agency_tag"] if event == "handoff" else None,
    )
    cid = str(thread["id"])

    if event == "handoff":
        tag = n["agency_tag"] or "AG_BUCARAMANGA"
        tags = list(thread.get("tags") or [])
        if tag not in tags:
            tags = [tag, *tags]
        thread = {
            **thread,
            "tags": tags,
            "botActive": False,
            "botPaused": True,
            "snippet": (n["text"] or f"Handoff {tag}")[:160],
            "aiSummary": {
                **(thread.get("aiSummary") or {}),
                "text": n["text"] or f"Transferido a {tag}",
                "etapa": "handoff",
            },
        }
        ops_store.upsert_conversation_thread(thread)
        # Best-effort LIWA tag (needs live mode)
        try:
            from pilot_core.modules.liwa_whatsapp import liwa_whatsapp_service
            from pilot_core.settings import get_settings

            if get_settings().liwa_live_enabled():
                await liwa_whatsapp_service.handoff_to_agency(
                    phone=phone,
                    first_name=n["first_name"],
                    tag_name=tag,
                    motivo=n["text"] or f"Handoff PULSO {tag}",
                )
                actions.append("liwa_tag_synced")
        except Exception:
            actions.append("liwa_tag_skipped")

        existing_ho = ops_store.find_queued_handoff(conversation_id=cid, phone=phone)
        ho_payload = {
            "id": (existing_ho or {}).get("id") or f"ho_{uuid4().hex[:10]}",
            "name": n["first_name"],
            "segment": "WhatsApp",
            "motivo": n["text"] or f"Handoff {tag}",
            "priority": "alta",
            "agency_tag": tag,
            "phone": phone,
            "conversationId": cid,
            "conversation_id": cid,
            "status": "queued",
            "source": (existing_ho or {}).get("source") or "liwa_inbound",
        }
        if existing_ho:
            ops_store.upsert_handoff(ho_payload)
            actions.append("handoff_reused")
        else:
            ops_store.insert_handoff(ho_payload)
            actions.append("handoff_queued")
        crm_lead = _crm_to(phone=phone, column="transferido", name=n["first_name"])
        actions.append("crm_transferido")
        actions.append("bot_paused")
        if n["text"]:
            ops_store.append_conversation_message(
                cid,
                {
                    "id": f"m_{uuid4().hex[:10]}",
                    "role": "bot",
                    "text": n["text"][:500],
                    "at": "ahora",
                    "source": "liwa_handoff",
                },
            )
        return {
            "ok": True,
            "event": "handoff",
            "phone": phone,
            "conversation_id": cid,
            "agency_tag": tag,
            "actions": actions,
            "crm": crm_lead,
            "normalized": n,
        }

    # message / bot_message / document
    msg_role = "bot" if event == "bot_message" else str(n.get("msg_role") or "user")
    if event == "document":
        msg_role = "user"
    msg: dict[str, Any] = {
        "id": f"m_{uuid4().hex[:10]}",
        "role": msg_role if msg_role in {"user", "bot"} else "user",
        "text": (n["text"] or ("Documento recibido" if event == "document" else ""))[:500]
        or "(sin texto)",
        "at": "ahora",
        "source": "liwa_bot" if msg_role == "bot" else "liwa_inbound",
    }
    if event == "document" or n["file_url"]:
        validated = (
            True
            if event == "document"
            else (bool(n["file_url"]) and str(n["file_name"]).lower().endswith(".pdf"))
        )
        msg["attachment"] = {
            "name": n["file_name"],
            "size": "—",
            "url": n["file_url"],
            "validated": validated,
        }
        exp = dict(thread.get("expediente") or {})
        docs = list(exp.get("documents") or [])
        docs.append({"name": n["file_name"], "url": n["file_url"], "validated": validated})
        exp["documents"] = docs[-20:]
        exp["estadoCrm"] = "Documento recibido"
        thread = {**thread, "expediente": exp, "snippet": f"Doc: {n['file_name']}"[:160]}
        ops_store.upsert_conversation_thread(thread)
        actions.append("document_attached")
        crm_lead = _crm_to(phone=phone, column="documento", name=n["first_name"])
        actions.append("crm_documento")

    # Ensure contactado at least on plain user messages
    if event in {"message", "bot_message"}:
        if event == "message":
            crm_lead = _crm_to(phone=phone, column="contactado", name=n["first_name"])
            actions.append("crm_contactado")
        else:
            actions.append("bot_message")

    ops_store.append_conversation_message(cid, msg)
    actions.append("message_appended")

    if n["csat"] is not None:
        record_csat(int(n["csat"]), phone=phone)
        actions.append("csat_recorded")

    return {
        "ok": True,
        "event": event,
        "phone": phone,
        "conversation_id": cid,
        "actions": actions,
        "crm": crm_lead,
        "normalized": n,
    }

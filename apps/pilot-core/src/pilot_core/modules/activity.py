"""activity — link outbound voz/WA to Conversaciones + dashboard store."""

from __future__ import annotations

import re
from typing import Any
from uuid import uuid4

from pilot_core import ops_store


def humanize_ops_text(text: str) -> str:
    """Remove provider jargon from operator-facing strings."""
    out = text or ""
    replacements = (
        ("elevenlabs_sip_trunk", "voz"),
        ("elevenlabs_sip", "voz"),
        ("live_dialer", "voz"),
        ("whatsapp_liwa", "whatsapp"),
        ("whatsapp_mock", "whatsapp"),
        ("liwa_mock", "whatsapp"),
        ("LIWA", "WhatsApp"),
        ("queued_mock", "en cola"),
    )
    for a, b in replacements:
        out = out.replace(a, b)
    out = re.sub(
        r"Llamada outbound\s*\([^)]*\)\s*·\s*sent",
        "Llamada de voz enviada",
        out,
        flags=re.I,
    )
    out = re.sub(r"\s*·\s*sent\b", " · enviada", out, flags=re.I)
    out = re.sub(r"\s*·\s*failed\b", " · fallida", out, flags=re.I)
    return out


def humanize_conversation_row(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key in ("snippet", "topic"):
        if isinstance(out.get(key), str):
            out[key] = humanize_ops_text(out[key])
    tags = out.get("tags")
    if isinstance(tags, list):
        out["tags"] = [
            t
            for t in tags
            if str(t).lower() not in {"laboratorio", "liwa"} and "elevenlabs" not in str(t).lower()
        ]
    msgs = out.get("messages")
    if isinstance(msgs, list):
        cleaned = []
        for m in msgs:
            if not isinstance(m, dict):
                cleaned.append(m)
                continue
            mm = dict(m)
            if isinstance(mm.get("text"), str):
                mm["text"] = humanize_ops_text(mm["text"])
            cleaned.append(mm)
        out["messages"] = cleaned
    ai = out.get("aiSummary")
    if isinstance(ai, dict) and isinstance(ai.get("text"), str):
        out["aiSummary"] = {**ai, "text": humanize_ops_text(ai["text"])}
    return out


def conversation_id_for_phone(phone: str) -> str:
    digits = re.sub(r"\D", "", phone or "")
    if len(digits) >= 8:
        return f"cv_{digits[-12:]}"
    return f"cv_{uuid4().hex[:12]}"


def human_voice_status(status: str) -> str:
    s = (status or "").lower()
    if s in {"sent", "ok", "success"}:
        return "enviada"
    if s in {"queued_mock", "queued"}:
        return "en cola"
    if s in {"failed", "error"}:
        return "fallida"
    return status or "registrada"


def record_outbound_conversation(
    *,
    phone: str,
    first_name: str = "Asociado",
    channel: str,
    snippet: str,
    topic: str | None = None,
    conversation_id: str | None = None,
    message_role: str = "bot",
) -> dict[str, Any]:
    """Create or update an inbox thread so outbound activity appears in Conversaciones."""
    cid = conversation_id or conversation_id_for_phone(phone)
    existing = None
    for t in ops_store.list_conversation_threads():
        if t.get("id") == cid:
            existing = t
            break
        exp_phone = str((t.get("expediente") or {}).get("phone") or "")
        if exp_phone and re.sub(r"\D", "", exp_phone) == re.sub(r"\D", "", phone):
            existing = t
            cid = str(t["id"])
            break

    channel_label = "WhatsApp" if channel == "whatsapp" else "Voz"
    msg = {
        "id": f"m_{uuid4().hex[:10]}",
        "role": message_role,
        "text": snippet[:500],
        "at": "ahora",
        "source": channel,
    }

    if existing:
        tags = [
            t for t in (existing.get("tags") or []) if str(t).lower() not in {"laboratorio", "liwa"}
        ]
        if channel_label not in tags:
            tags = [channel_label, *tags]
        thread = {
            **existing,
            "snippet": snippet[:160],
            "channel": channel,
            "topic": topic or existing.get("topic") or channel_label,
            "tags": tags,
            "botActive": True,
            "aiSummary": {
                **(existing.get("aiSummary") or {}),
                "text": snippet[:240],
            },
        }
        ops_store.upsert_conversation_thread(thread)
        ops_store.append_conversation_message(cid, msg)
        return thread

    name = (first_name or "Asociado").strip() or "Asociado"
    thread = {
        "id": cid,
        "name": name,
        "topic": topic or f"Contacto {channel_label}",
        "snippet": snippet[:160],
        "channel": channel,
        "sentiment": "neutral",
        "tags": [channel_label],
        "botActive": True,
        "botPaused": False,
        "messages": [msg],
        "expediente": {
            "cedula": "-",
            "universidad": "-",
            "programa": "-",
            "semestre": "-",
            "cuotasPagadas": 0,
            "cuotasTotal": 1,
            "estadoCrm": "Contactado",
            "score": 70,
            "scoreLabel": "Media",
            "phone": phone,
        },
        "aiSummary": {
            "text": snippet[:240],
            "intencion": "contacto_outbound",
            "etapa": "inicio",
            "sentimiento": "neutral",
        },
    }
    ops_store.upsert_conversation_thread(thread)
    return thread

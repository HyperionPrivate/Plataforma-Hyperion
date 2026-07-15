"""post_call — tipificación post-llamada → WhatsApp si la intención es continuar."""

from __future__ import annotations

import hmac
import hashlib
import re
from typing import Any
from uuid import uuid4

from pilot_core import ops_store
from pilot_core.modules.crm.service import crm_service
from pilot_core.modules.liwa_whatsapp import liwa_whatsapp_service
from pilot_core.modules.whatsapp_mock import whatsapp_mock_service
from pilot_core.settings import get_settings

# Intenciones que disparan seguimiento WA (orden de matrícula / flujo renovación).
_CONTINUE = frozenset(
    {
        "interesado",
        "renovar",
        "continuar",
        "si",
        "sí",
        "yes",
        "true",
        "1",
        "qualified",
        "lead_qualified",
        "quiere_renovar",
        "follow_up",
        "follow_up_whatsapp",
        "documento",
        "enviar_documento",
        "doc_solicitado",
        "success_interested",
    }
)

_STOP = frozenset(
    {
        "no_interes",
        "no_interest",
        "no",
        "false",
        "0",
        "opt_out",
        "optout",
        "voicemail",
        "amd",
        "no_answer",
        "busy",
        "failed",
        "hangup",
        "rechazo",
        "no_contesta",
    }
)

_SUMMARY_CONTINUE = re.compile(
    r"\b(interesad[oa]|quiere renovar|desea renovar|acept[oa]|continuar|"
    r"enviar (el )?documento|orden de matr[ií]cula|cupo preaprobado)\b",
    re.I,
)
_SUMMARY_STOP = re.compile(
    r"\b(no le interesa|no interesa|no desea|rechaz|opt[- ]?out|buz[oó]n|"
    r"no contest|colg[oó]|voicemail)\b",
    re.I,
)


def normalize_intent(raw: str | None) -> str:
    if not raw:
        return "unknown"
    s = str(raw).strip().lower()
    s = s.replace("-", "_").replace(" ", "_")
    aliases = {
        "interested": "interesado",
        "interest": "interesado",
        "renew": "renovar",
        "renewal": "renovar",
        "continue": "continuar",
        "sí": "si",
        "no_interesado": "no_interes",
        "not_interested": "no_interes",
        "machine": "voicemail",
        "answering_machine": "voicemail",
    }
    return aliases.get(s, s)


def intent_wants_whatsapp(intent: str) -> bool:
    n = normalize_intent(intent)
    if n in _STOP:
        return False
    if n in _CONTINUE:
        return True
    return False


def infer_intent_from_payload(payload: dict[str, Any]) -> tuple[str, str]:
    """Return (intent, source). Accepts ops body or ElevenLabs post_call_transcription."""
    if payload.get("intent") or payload.get("disposition") or payload.get("tipificacion"):
        raw = payload.get("intent") or payload.get("disposition") or payload.get("tipificacion")
        return normalize_intent(str(raw)), "explicit"

    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    analysis = data.get("analysis") if isinstance(data.get("analysis"), dict) else {}
    collected = analysis.get("data_collection_results") or {}
    if isinstance(collected, dict):
        for key in (
            "intencion",
            "intent",
            "interesado",
            "disposition",
            "tipificacion",
            "quiere_renovar",
            "follow_up_whatsapp",
        ):
            block = collected.get(key)
            if isinstance(block, dict) and block.get("value") is not None:
                return normalize_intent(str(block["value"])), f"data_collection:{key}"
            if isinstance(block, str) and block.strip():
                return normalize_intent(block), f"data_collection:{key}"

    summary = str(analysis.get("transcript_summary") or "")
    if summary and _SUMMARY_STOP.search(summary):
        return "no_interes", "transcript_summary"
    if summary and _SUMMARY_CONTINUE.search(summary):
        return "interesado", "transcript_summary"

    call_ok = str(analysis.get("call_successful") or "").lower()
    if call_ok in {"failure", "failed", "unsuccessful"}:
        return "failed", "call_successful"
    # success alone ≠ interés; no auto-WA
    return "unknown", "default"


def extract_phone_from_payload(payload: dict[str, Any]) -> str | None:
    for key in ("phone", "to_number", "contact_phone"):
        v = payload.get(key)
        if v:
            return str(v).strip()
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    meta = data.get("metadata") if isinstance(data.get("metadata"), dict) else {}
    for key in ("phone", "to_number", "called_number", "external_number"):
        v = meta.get(key) or data.get(key)
        if v:
            return str(v).strip()
    init = data.get("conversation_initiation_client_data")
    if isinstance(init, dict):
        dyn = init.get("dynamic_variables") or {}
        if isinstance(dyn, dict) and dyn.get("phone"):
            return str(dyn["phone"]).strip()
    return None


def extract_name_from_payload(payload: dict[str, Any]) -> str:
    for key in ("first_name", "name"):
        v = payload.get(key)
        if v:
            return str(v).strip()
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    init = data.get("conversation_initiation_client_data")
    if isinstance(init, dict):
        dyn = init.get("dynamic_variables") or {}
        if isinstance(dyn, dict):
            for key in ("nombre", "first_name", "name"):
                if dyn.get(key):
                    return str(dyn[key]).strip()
    return "Asociado"


def extract_conversation_id(payload: dict[str, Any]) -> str | None:
    if payload.get("conversation_id"):
        return str(payload["conversation_id"])
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    if data.get("conversation_id"):
        return str(data["conversation_id"])
    return None


def verify_elevenlabs_signature(*, body: bytes, signature_header: str | None, secret: str) -> bool:
    """Validate ElevenLabs `elevenlabs-signature: t=...,v0=...` HMAC-SHA256."""
    if not secret or not signature_header:
        return False
    parts = dict(
        p.split("=", 1) for p in signature_header.split(",") if "=" in p
    )
    ts = parts.get("t")
    v0 = parts.get("v0")
    if not ts or not v0:
        return False
    expected = hmac.new(
        secret.encode("utf-8"),
        f"{ts}.".encode("utf-8") + body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, v0)


class PostCallService:
    name: str = "post_call"

    def ping(self) -> str:
        return self.name

    async def process(
        self,
        *,
        phone: str | None = None,
        first_name: str = "Asociado",
        intent: str | None = None,
        skip_whatsapp: bool = False,
        conversation_id: str | None = None,
        dispatch_id: str | None = None,
        raw_payload: dict[str, Any] | None = None,
        source: str = "ops",
    ) -> dict[str, Any]:
        payload = raw_payload or {}
        inferred, infer_source = infer_intent_from_payload(
            {**payload, **({"intent": intent} if intent else {})}
        )
        if intent:
            inferred = normalize_intent(intent)
            infer_source = "explicit"

        phone_n = (phone or extract_phone_from_payload(payload) or "").strip()
        name = first_name if first_name != "Asociado" else extract_name_from_payload(payload)
        conv_id = conversation_id or extract_conversation_id(payload)

        # Resolver teléfono desde dispatch reciente si el webhook no lo trae.
        if not phone_n and conv_id:
            for d in ops_store.list_dispatches(50):
                if str(d.get("conversation_id") or "") == conv_id:
                    lead = d.get("lead") if isinstance(d.get("lead"), dict) else {}
                    phone_n = str(lead.get("phone") or "").strip()
                    if name == "Asociado" and lead.get("first_name"):
                        name = str(lead["first_name"])
                    if not dispatch_id:
                        dispatch_id = str(d.get("id") or "") or None
                    break
        if not phone_n:
            for d in ops_store.list_dispatches(10):
                lead = d.get("lead") if isinstance(d.get("lead"), dict) else {}
                if lead.get("phone") and d.get("status") in {"sent", "queued_mock"}:
                    phone_n = str(lead["phone"]).strip()
                    if name == "Asociado" and lead.get("first_name"):
                        name = str(lead["first_name"])
                    if not dispatch_id:
                        dispatch_id = str(d.get("id") or "") or None
                    break

        if conv_id:
            prior = ops_store.get_post_call_by_conversation(conv_id)
            if prior:
                return {
                    "ok": True,
                    "idempotent": True,
                    "intent": prior.get("intent"),
                    "whatsapp_sent": prior.get("whatsapp_sent"),
                    "result": prior,
                }

        wants_wa = intent_wants_whatsapp(inferred)
        result: dict[str, Any] = {
            "id": f"pc_{uuid4().hex[:10]}",
            "ok": True,
            "source": source,
            "phone": phone_n or None,
            "first_name": name,
            "conversation_id": conv_id,
            "intent": inferred,
            "intent_source": infer_source,
            "wants_whatsapp": wants_wa,
            "whatsapp_sent": False,
            "whatsapp": None,
            "crm": None,
            "dispatch_id": dispatch_id,
        }

        # CRM tipificación
        try:
            crm = self._update_crm(phone=phone_n, name=name, intent=inferred, wants_wa=wants_wa)
            result["crm"] = crm
        except Exception as exc:  # noqa: BLE001
            result["crm"] = {"ok": False, "error": str(exc)}

        if wants_wa and not skip_whatsapp and phone_n:
            settings = get_settings()
            if settings.liwa_live_enabled():
                wa = await liwa_whatsapp_service.send(
                    phone=phone_n,
                    first_name=name,
                    kind="flow",
                    flow_id=None,
                    text="Seguimiento post-llamada renovación",
                )
            else:
                wa = whatsapp_mock_service.send_text(
                    phone=phone_n,
                    text="[post-call] Flujo renovación — envíe su orden de matrícula.",
                    template="renovacion_post_call",
                )
            result["whatsapp"] = wa
            result["whatsapp_sent"] = bool(wa.get("ok"))
        elif wants_wa and not phone_n:
            result["whatsapp"] = {"ok": False, "error": "phone_missing"}
        elif not wants_wa:
            result["whatsapp"] = {
                "ok": True,
                "skipped": True,
                "reason": f"intent_not_continue:{inferred}",
            }

        if dispatch_id:
            self._patch_dispatch(dispatch_id, result)
        elif phone_n:
            self._patch_latest_dispatch_for_phone(phone_n, result)

        ops_store.insert_post_call(result)
        return result

    def _update_crm(
        self, *, phone: str, name: str, intent: str, wants_wa: bool
    ) -> dict[str, Any]:
        lead = crm_service.create_lead(name=name, funnel="Renovación", phone=phone or None)
        lead_id = str(lead.get("id") or "")
        if not lead_id:
            return lead
        # pendiente → contactado
        lead = crm_service.move(lead_id=lead_id, to_column="contactado")
        if wants_wa:
            lead = crm_service.move(
                lead_id=lead_id, to_column="interesado", tipificacion=intent
            )
            lead = crm_service.move(
                lead_id=lead_id, to_column="documento", tipificacion="doc_solicitado"
            )
        elif intent in _STOP and intent not in {"voicemail", "no_answer", "busy", "amd"}:
            lead = crm_service.move(
                lead_id=lead_id, to_column="no_interes", tipificacion=intent or "no_interes"
            )
        else:
            lead["tipificacion"] = intent
            ops_store.upsert_crm_lead(lead)
        return lead

    def _patch_dispatch(self, dispatch_id: str, post_call: dict[str, Any]) -> None:
        d = ops_store.get_dispatch(dispatch_id)
        if not d:
            return
        d["post_call"] = {
            "intent": post_call.get("intent"),
            "whatsapp_sent": post_call.get("whatsapp_sent"),
            "post_call_id": post_call.get("id"),
        }
        d["status"] = "completed"
        ops_store.upsert_dispatch(d)

    def _patch_latest_dispatch_for_phone(self, phone: str, post_call: dict[str, Any]) -> None:
        for d in ops_store.list_dispatches(30):
            lead = d.get("lead") if isinstance(d.get("lead"), dict) else {}
            if str(lead.get("phone") or d.get("phone") or "") == phone:
                self._patch_dispatch(str(d["id"]), post_call)
                post_call["dispatch_id"] = d["id"]
                return


post_call_service = PostCallService()

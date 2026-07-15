"""post_call — tipificación post-llamada → WhatsApp si la intención es continuar."""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from typing import Any
from uuid import uuid4

from pilot_core import ops_store
from pilot_core.modules.compliance.service import compliance_service
from pilot_core.modules.crm.service import crm_service
from pilot_core.modules.liwa_whatsapp import liwa_whatsapp_service
from pilot_core.modules.product_flow import resolve_product_flow
from pilot_core.modules.whatsapp_mock import whatsapp_mock_service
from pilot_core.phone import normalize_phone
from pilot_core.settings import get_settings

# Max age for ElevenLabs webhook signature timestamp (seconds).
_WEBHOOK_SIGNATURE_MAX_AGE_SEC = 300

# Intenciones que disparan seguimiento WA (A renovación / B reactivación).
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
        "reactivar",
        "reactivacion",
        "quiere_reactivar",
        "retomar",
        "retoma_estudios",
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
    r"reactivar|reactivaci[oó]n|retomar|retoma|quiere reactivar|"
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
        "reactivation": "reactivar",
        "reactivar_credito": "reactivar",
    }
    return aliases.get(s, s)


def intent_wants_whatsapp(intent: str) -> bool:
    n = normalize_intent(intent)
    if n in _STOP:
        return False
    return n in _CONTINUE


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def infer_intent_from_payload(payload: dict[str, Any]) -> tuple[str, str]:
    """Return (intent, source). Accepts ops body or ElevenLabs post_call_transcription."""
    if payload.get("intent") or payload.get("disposition") or payload.get("tipificacion"):
        raw = payload.get("intent") or payload.get("disposition") or payload.get("tipificacion")
        return normalize_intent(str(raw)), "explicit"

    data = _as_dict(payload.get("data")) if "data" in payload else payload
    analysis = _as_dict(data.get("analysis"))
    collected = _as_dict(analysis.get("data_collection_results"))
    for key in (
        "intencion",
        "intent",
        "interesado",
        "disposition",
        "tipificacion",
        "quiere_renovar",
        "quiere_reactivar",
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
    return "unknown", "default"


def extract_phone_from_payload(payload: dict[str, Any]) -> str | None:
    for key in ("phone", "to_number", "contact_phone"):
        v = payload.get(key)
        if v:
            return str(v).strip()
    data = _as_dict(payload.get("data"))
    meta = _as_dict(data.get("metadata"))
    for key in ("phone", "to_number", "called_number", "external_number"):
        v = meta.get(key) or data.get(key)
        if v:
            return str(v).strip()
    init = _as_dict(data.get("conversation_initiation_client_data"))
    dyn = _as_dict(init.get("dynamic_variables"))
    if dyn.get("phone"):
        return str(dyn["phone"]).strip()
    return None


def extract_name_from_payload(payload: dict[str, Any]) -> str:
    for key in ("first_name", "name"):
        v = payload.get(key)
        if v:
            return str(v).strip()
    data = _as_dict(payload.get("data"))
    init = _as_dict(data.get("conversation_initiation_client_data"))
    dyn = _as_dict(init.get("dynamic_variables"))
    for key in ("nombre", "first_name", "name"):
        if dyn.get(key):
            return str(dyn[key]).strip()
    return "Asociado"


def extract_conversation_id(payload: dict[str, Any]) -> str | None:
    if payload.get("conversation_id"):
        return str(payload["conversation_id"])
    data = _as_dict(payload.get("data"))
    if data.get("conversation_id"):
        return str(data["conversation_id"])
    return None


def verify_elevenlabs_signature(
    *,
    body: bytes,
    signature_header: str | None,
    secret: str,
    now: float | None = None,
    max_age_sec: int = _WEBHOOK_SIGNATURE_MAX_AGE_SEC,
) -> bool:
    """Validate ElevenLabs `elevenlabs-signature: t=...,v0=...` HMAC-SHA256.

    Also rejects signatures whose timestamp is older than ``max_age_sec``
    (replay protection).
    """
    if not secret or not signature_header:
        return False
    parts = dict(p.split("=", 1) for p in signature_header.split(",") if "=" in p)
    ts = parts.get("t")
    v0 = parts.get("v0")
    if not ts or not v0:
        return False
    try:
        ts_i = int(ts)
    except ValueError:
        return False
    current = time.time() if now is None else now
    if abs(current - ts_i) > max_age_sec:
        return False
    expected = hmac.new(
        secret.encode("utf-8"),
        f"{ts}.".encode() + body,
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
        flow: str | None = None,
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

        phone_n = (
            normalize_phone(phone or extract_phone_from_payload(payload) or "")
            or (phone or extract_phone_from_payload(payload) or "").strip()
        )
        name = first_name if first_name != "Asociado" else extract_name_from_payload(payload)
        conv_id = conversation_id or extract_conversation_id(payload)
        resolved_flow = flow
        data = _as_dict(payload.get("data"))
        agent_id = str(data["agent_id"]) if data.get("agent_id") else None

        # Resolve phone only via conversation_id / explicit dispatch — never the
        # most recent unrelated dispatch (wrong-lead risk).
        if not phone_n and conv_id:
            for d in ops_store.list_dispatches(50):
                if str(d.get("conversation_id") or "") == conv_id:
                    lead = _as_dict(d.get("lead"))
                    phone_n = (
                        normalize_phone(str(lead.get("phone") or ""))
                        or str(lead.get("phone") or "").strip()
                    )
                    if name == "Asociado" and lead.get("first_name"):
                        name = str(lead["first_name"])
                    if not dispatch_id:
                        dispatch_id = str(d.get("id") or "") or None
                    if not resolved_flow and d.get("flow"):
                        resolved_flow = str(d.get("flow"))
                    break
        if not phone_n and dispatch_id:
            matched = ops_store.get_dispatch(dispatch_id)
            if matched:
                lead = _as_dict(matched.get("lead"))
                phone_n = (
                    normalize_phone(str(lead.get("phone") or matched.get("phone") or ""))
                    or str(lead.get("phone") or matched.get("phone") or "").strip()
                )
                if name == "Asociado" and lead.get("first_name"):
                    name = str(lead["first_name"])
                if not resolved_flow and matched.get("flow"):
                    resolved_flow = str(matched.get("flow"))

        product = resolve_product_flow(resolved_flow, agent_id=agent_id, payload=payload)

        claim_id = f"pc_{uuid4().hex[:10]}"
        claimed = True
        if conv_id:
            claimed, prior = ops_store.claim_post_call_conversation(
                conv_id,
                {
                    "id": claim_id,
                    "conversation_id": conv_id,
                    "phone": phone_n or None,
                    "source": source,
                    "status": "processing",
                },
            )
            if not claimed and prior:
                # Only short-circuit true completions; failed claims were reclaimed above.
                if prior.get("status") == "completed":
                    return {
                        "ok": True,
                        "idempotent": True,
                        "intent": prior.get("intent"),
                        "whatsapp_sent": prior.get("whatsapp_sent"),
                        "flow": prior.get("flow"),
                        "result": prior,
                    }
                if prior.get("status") == "processing":
                    return {
                        "ok": False,
                        "idempotent": True,
                        "in_flight": True,
                        "intent": prior.get("intent"),
                        "whatsapp_sent": prior.get("whatsapp_sent"),
                        "flow": prior.get("flow"),
                        "result": prior,
                    }

        wants_wa = intent_wants_whatsapp(inferred)
        result: dict[str, Any] = {
            "id": claim_id,
            "ok": True,
            "source": source,
            "phone": phone_n or None,
            "first_name": name,
            "conversation_id": conv_id,
            "flow": product["flow"],
            "product": {
                "name": product["name"],
                "segment": product["segment"],
                "crm_funnel": product["crm_funnel"],
                "liwa_flow_id": product["liwa_flow_id"],
                "liwa_handoff_tag": product["liwa_handoff_tag"],
                "liwa_flow_fallback_to_a": product["liwa_flow_fallback_to_a"],
            },
            "intent": inferred,
            "intent_source": infer_source,
            "wants_whatsapp": wants_wa,
            "whatsapp_sent": False,
            "whatsapp": None,
            "crm": None,
            "dispatch_id": dispatch_id,
        }

        try:
            try:
                result["crm"] = self._update_crm(
                    phone=phone_n,
                    name=name,
                    intent=inferred,
                    wants_wa=wants_wa,
                    funnel=str(product["crm_funnel"]),
                )
            except Exception:  # noqa: BLE001
                result["crm"] = {"ok": False, "error": "crm_update_failed"}

            if wants_wa and not skip_whatsapp and phone_n:
                decision = compliance_service.evaluate(phone=phone_n, channel="whatsapp")
                result["compliance"] = compliance_service.as_dict(decision)
                if not decision.allowed:
                    result["whatsapp"] = {
                        "ok": False,
                        "blocked": True,
                        "compliance": result["compliance"],
                    }
                    result["whatsapp_sent"] = False
                else:
                    settings = get_settings()
                    if settings.liwa_live_enabled():
                        wa = await liwa_whatsapp_service.send(
                            phone=phone_n,
                            first_name=name,
                            kind="flow",
                            flow_id=str(product["liwa_flow_id"] or "") or None,
                            text=str(product["wa_followup_text"]),
                        )
                    else:
                        wa = whatsapp_mock_service.send_text(
                            phone=phone_n,
                            text=f"[post-call][{product['flow']}] {product['wa_followup_text']}",
                            template=f"{product['continue_label']}_post_call",
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

            # Provider failure → failed (retryable), not completed (terminal).
            wa = result.get("whatsapp") or {}
            provider_failed = bool(
                wants_wa
                and not skip_whatsapp
                and phone_n
                and wa.get("blocked") is not True
                and wa.get("skipped") is not True
                and wa.get("ok") is False
            )
            if provider_failed:
                result["ok"] = False
                result["status"] = "failed"
                result["error"] = wa.get("error") or "whatsapp_send_failed"
                ops_store.insert_post_call(result)
                return result

            result["status"] = "completed"
            ops_store.insert_post_call(result)
            return result
        except Exception as exc:  # noqa: BLE001
            # Release claim immediately so ElevenLabs / callers can retry.
            if claimed and conv_id:
                ops_store.release_post_call_claim(claim_id, error=str(exc))
            return {
                "ok": False,
                "id": claim_id,
                "status": "failed",
                "error": "post_call_exception",
                "detail": str(exc)[:200],
                "conversation_id": conv_id,
                "phone": phone_n or None,
                "whatsapp_sent": False,
            }

    def _update_crm(
        self,
        *,
        phone: str,
        name: str,
        intent: str,
        wants_wa: bool,
        funnel: str = "Renovación",
    ) -> dict[str, Any]:
        lead = crm_service.create_lead(name=name, funnel=funnel, phone=phone or None)
        lead_id = str(lead.get("id") or "")
        if not lead_id:
            return lead
        lead = crm_service.move(lead_id=lead_id, to_column="contactado")
        if wants_wa:
            lead = crm_service.move(lead_id=lead_id, to_column="interesado", tipificacion=intent)
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
            "flow": post_call.get("flow"),
        }
        d["status"] = "completed"
        ops_store.upsert_dispatch(d)

    def _patch_latest_dispatch_for_phone(self, phone: str, post_call: dict[str, Any]) -> None:
        phone_n = normalize_phone(phone) or phone
        for d in ops_store.list_dispatches(30):
            lead = _as_dict(d.get("lead"))
            candidate = normalize_phone(str(lead.get("phone") or d.get("phone") or "")) or str(
                lead.get("phone") or d.get("phone") or ""
            )
            if candidate and candidate == phone_n:
                self._patch_dispatch(str(d["id"]), post_call)
                post_call["dispatch_id"] = d["id"]
                return


post_call_service = PostCallService()

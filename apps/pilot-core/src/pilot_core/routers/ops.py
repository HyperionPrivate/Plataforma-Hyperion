"""Ops product API - shapes aligned with apps/web MODULES.md (piloto PULSO)."""

from __future__ import annotations

import json
from datetime import time
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from platform_kit.auth import AuthContext, require_auth
from platform_kit.errors import PlatformError
from pydantic import BaseModel, Field

from pilot_core import ops_store
from pilot_core.modules.agent_config.service import agent_config_service
from pilot_core.modules.analytics.service import analytics_service
from pilot_core.modules.campaigns.service import campaigns_service
from pilot_core.modules.compliance.service import compliance_service
from pilot_core.modules.contacts.service import contacts_service
from pilot_core.modules.core_adapter.service import core_adapter_service
from pilot_core.modules.crm.service import crm_service
from pilot_core.modules.documents_service import documents_service
from pilot_core.modules.orchestration.service import orchestration_service
from pilot_core.modules.pii import (
    mask_contact,
    mask_conversation,
    mask_crm_card,
    mask_handoff_row,
    pii_masking_enabled,
)
from pilot_core.modules.post_call.service import post_call_service, verify_elevenlabs_signature
from pilot_core.modules.segmentation.service import segmentation_service
from pilot_core.modules.liwa_whatsapp import liwa_whatsapp_service
from pilot_core.modules.whatsapp_mock import whatsapp_mock_service
from pilot_core.settings import get_settings

router = APIRouter(prefix="/ops", tags=["ops-product"])

_FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "ops"
ops_store.init_db()


def _hydrate_runtime_from_store() -> None:
    """Apply dialer/channels persisted in SQLite to this process."""
    dialer = ops_store.get_setting("dialer")
    if isinstance(dialer, dict):
        s = get_settings()
        if "base_url" in dialer:
            object.__setattr__(s, "dialer_base_url", str(dialer.get("base_url") or ""))
        if "default_phone_number_id" in dialer:
            object.__setattr__(
                s,
                "dialer_default_phone_number_id",
                str(dialer.get("default_phone_number_id") or ""),
            )
    channels = ops_store.get_setting("channels")
    if isinstance(channels, dict) and channels.get("ventana_8_20") is False:
        compliance_service.window_start = time(0, 0)
        compliance_service.window_end = time(23, 59)
    compliance_service.hydrate()


_hydrate_runtime_from_store()


def _load(name: str) -> dict[str, Any]:
    path = _FIXTURES / name
    return json.loads(path.read_text(encoding="utf-8"))


@router.get("/dashboard")
async def ops_dashboard(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    data = _load("dashboard.json")
    stored = ops_store.list_dispatches(5)
    if stored:
        live = []
        for d in stored:
            lead = d.get("lead") or {}
            live.append(
                {
                    "id": d.get("id"),
                    "channel": "whatsapp" if "whatsapp" in str(d.get("mode")) else "voz",
                    "personName": lead.get("first_name") or "Lead",
                    "kind": "Dispatch " + str(d.get("status") or d.get("mode") or "ok"),
                    "at": "ahora",
                }
            )
        data = {**data, "liveEvents": [*live, *data.get("liveEvents", [])][:12]}
    return analytics_service.overlay_dashboard(data)


@router.get("/campaigns")
async def ops_campaigns(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    data = _load("campaigns.json")
    extra = ops_store.list_campaigns()
    if extra:
        data = {**data, "campaigns": [*extra, *data.get("campaigns", [])]}
    # Overlay day chips from real dispatches when activity exists.
    dispatches = ops_store.list_dispatches(200)
    if dispatches:
        voice = sum(1 for d in dispatches if "whatsapp" not in str(d.get("mode", "")))
        wa = sum(1 for d in dispatches if "whatsapp" in str(d.get("mode", "")))
        chips = dict(data.get("dayChips") or {})
        chips["llamadasHoy"] = voice
        chips["whatsappHoy"] = wa
        chips["reintentos"] = sum(
            1 for d in dispatches if d.get("status") in {"failed", "queued_mock"}
        )
        data = {**data, "dayChips": chips}
    return data


@router.get("/crm")
async def ops_crm(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    data = crm_service.snapshot()
    if pii_masking_enabled():
        funnels = data.get("funnels") or {}
        for funnel in funnels.values():
            for col in funnel.get("columns") or []:
                col["cards"] = [mask_crm_card(c) for c in (col.get("cards") or [])]
    return data


@router.get("/handoff")
async def ops_handoff(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    data = _load("handoff.json")
    extra = ops_store.list_handoffs(20)
    if extra:
        queue = []
        for h in extra:
            info = h.get("info")
            if not isinstance(info, dict):
                info = {
                    "universidad": "-",
                    "programa": "-",
                    "canal": "whatsapp" if h.get("phone") else "voz",
                    "phone": h.get("phone") or (info if isinstance(info, str) else ""),
                }
            queue.append(
                {
                    "id": h.get("id"),
                    "conversationId": h.get("conversationId") or h.get("id"),
                    "priority": h.get("priority", "alta"),
                    "name": h.get("name", "Lead"),
                    "segment": h.get("segment", "Renovacion"),
                    "motivo": h.get("motivo", "Calificado por laboratorio"),
                    "expedientePct": h.get("expedientePct", 80),
                    "tiempoCola": h.get("tiempoCola", "0h 05m"),
                    "asesor": h.get("asesor"),
                    "aiSummary": h.get("aiSummary", "Handoff creado desde API"),
                    "info": info,
                }
            )
        data = {**data, "queue": [*queue, *data.get("queue", [])]}
    # Overlay KPI cola with merged queue length.
    if ops_store.list_handoffs(1):
        queue_len = len(data.get("queue") or [])
        kpis = []
        for k in data.get("kpis") or []:
            if k.get("id") == "cola":
                kpis.append({**k, "value": queue_len})
            else:
                kpis.append(k)
        data = {**data, "kpis": kpis}
    if pii_masking_enabled():
        data = {
            **data,
            "queue": [mask_handoff_row(r) for r in (data.get("queue") or [])],
        }
    return data


class CreateCampaignBody(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    segment: str = Field(default="Renovacion")
    channels: list[str] = Field(default_factory=lambda: ["voz"])
    total: int = Field(default=0, ge=0)


class ImportContactsBody(BaseModel):
    rows: list[dict[str, Any]] = Field(default_factory=list)
    commit: bool = False


class CreateHandoffBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    segment: str = "Renovacion"
    motivo: str = "Lead calificado"
    priority: str = "alta"
    phone: str | None = None
    agency_tag: str | None = None


class OptOutBody(BaseModel):
    phone: str = Field(min_length=8, max_length=20)


@router.post("/contacts/import")
async def import_contacts(
    body: ImportContactsBody,
    _ctx: AuthContext = Depends(require_auth),
) -> dict[str, Any]:
    if body.commit:
        return contacts_service.commit_valid(body.rows)
    return contacts_service.preview_rows(body.rows)


@router.get("/contacts")
async def list_contacts(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    data = contacts_service.list_contacts()
    if pii_masking_enabled() and isinstance(data, dict):
        items = data.get("items") or data.get("contacts") or []
        key = "items" if "items" in data else "contacts" if "contacts" in data else None
        if key:
            data = {**data, key: [mask_contact(c) for c in items]}
    return data


@router.post("/campaigns")
async def create_campaign(
    body: CreateCampaignBody,
    _ctx: AuthContext = Depends(require_auth),
) -> dict[str, Any]:
    return campaigns_service.create(
        name=body.name,
        segment=body.segment,
        channels=body.channels,
        total=body.total,
    )


class AttemptBody(BaseModel):
    phone: str = Field(min_length=8, max_length=20)
    first_name: str = Field(default="Asociado", max_length=80)
    campaign_id: str | None = None
    flow: str = Field(default="A", pattern="^[AB]$")


@router.post("/orchestration/attempt")
async def orchestration_attempt(
    body: AttemptBody,
    ctx: AuthContext = Depends(require_auth),
) -> dict[str, Any]:
    result = await orchestration_service.attempt_call(
        phone=body.phone,
        first_name=body.first_name,
        campaign_id=body.campaign_id,
        flow=body.flow,
        tenant_id=ctx.tenant_id,
    )
    if result.get("blocked"):
        raise PlatformError(
            "compliance_blocked",
            ",".join((result.get("compliance") or {}).get("reasons") or []) or "blocked",
            status_code=403,
        )
    return result


@router.post("/handoff")
async def create_handoff(
    body: CreateHandoffBody,
    _ctx: AuthContext = Depends(require_auth),
) -> dict[str, Any]:
    hid = f"h_{uuid4().hex[:10]}"
    cid = f"cv_{uuid4().hex[:10]}"
    thread = {
        "id": cid,
        "name": body.name,
        "topic": body.segment,
        "snippet": body.motivo,
        "sentiment": "neutral",
        "tags": ["Handoff", body.segment],
        "botActive": True,
        "botPaused": False,
        "messages": [
            {
                "id": f"m_{uuid4().hex[:8]}",
                "role": "bot",
                "text": f"Transferencia a asesor: {body.motivo}",
                "at": "ahora",
            }
        ],
        "expediente": {
            "cedula": "-",
            "universidad": "-",
            "programa": "-",
            "semestre": "-",
            "cuotasPagadas": 0,
            "cuotasTotal": 1,
            "estadoCrm": "Handoff",
            "score": 70,
            "scoreLabel": "Media",
        },
        "aiSummary": {
            "text": body.motivo,
            "intencion": "handoff",
            "etapa": "asesor",
            "sentimiento": "neutral",
        },
    }
    ops_store.upsert_conversation_thread(thread)
    liwa_meta: dict[str, Any] = {"synced": False}
    settings = get_settings()
    if body.phone and settings.liwa_live_enabled():
        liwa_meta = await liwa_whatsapp_service.handoff_to_agency(
            phone=body.phone,
            first_name=body.name.split()[0] if body.name else "Asociado",
            motivo=body.motivo,
            tag_name=body.agency_tag,
        )
        liwa_meta["synced"] = bool(liwa_meta.get("ok"))
    entry = {
        "id": hid,
        "conversationId": cid,
        "name": body.name,
        "segment": body.segment,
        "motivo": body.motivo,
        "priority": body.priority,
        "phone": body.phone,
        "expedientePct": 85,
        "tiempoCola": "0h 01m",
        "asesor": None,
        "aiSummary": "Creado desde laboratorio/API",
        "liwa": liwa_meta,
        "info": {
            "universidad": "-",
            "programa": "-",
            "canal": "whatsapp" if body.phone else "voz",
            "phone": body.phone or "",
            "liwa_tag": liwa_meta.get("tag_name"),
            "liwa_contact_id": liwa_meta.get("contact_id"),
        },
    }
    return ops_store.insert_handoff(entry)


@router.post("/compliance/opt-out")
async def opt_out(body: OptOutBody, _ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    return {"ok": True, **compliance_service.suppress(body.phone)}


@router.get("/compliance/opt-outs")
async def list_opt_outs(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    phones = compliance_service.list_suppressed()
    return {"items": phones, "total": len(phones)}


class DispatchCallBody(BaseModel):
    phone: str = Field(min_length=8, max_length=20, description="E.164 preferred")
    first_name: str = Field(default="Asociado", max_length=80)
    campaign_id: str | None = None
    agent_phone_number_id: str | None = None
    flow: str = Field(default="A", pattern="^[AB]$")


@router.post("/calls/dispatch")
async def dispatch_call(
    body: DispatchCallBody,
    ctx: AuthContext = Depends(require_auth),
) -> dict[str, Any]:
    """Compliance gate + Dialer HTTP (mock si no hay DIALER_BASE_URL)."""
    return await orchestration_service.attempt_call(
        phone=body.phone,
        first_name=body.first_name,
        campaign_id=body.campaign_id,
        flow=body.flow,
        tenant_id=ctx.tenant_id,
    )


class CallCompleteBody(BaseModel):
    phone: str = Field(min_length=8, max_length=20)
    first_name: str = Field(default="Asociado", max_length=80)
    intent: str = Field(
        default="interesado",
        description="Tipificación: interesado|renovar|no_interes|voicemail|...",
    )
    skip_whatsapp: bool = False
    conversation_id: str | None = None
    dispatch_id: str | None = None


@router.post("/calls/complete")
async def complete_call(
    body: CallCompleteBody,
    _ctx: AuthContext = Depends(require_auth),
) -> dict[str, Any]:
    """Post-llamada: tipifica intención y, si continúa, envía flujo WhatsApp."""
    return await post_call_service.process(
        phone=body.phone,
        first_name=body.first_name,
        intent=body.intent,
        skip_whatsapp=body.skip_whatsapp,
        conversation_id=body.conversation_id,
        dispatch_id=body.dispatch_id,
        source="ops",
    )


@router.post("/webhooks/elevenlabs/post-call")
async def elevenlabs_post_call_webhook(request: Request) -> dict[str, Any]:
    """Webhook ElevenLabs `post_call_transcription` → tipificación → WA si interesa."""
    raw = await request.body()
    settings = get_settings()
    secret = (settings.elevenlabs_webhook_secret or "").strip()
    sig = request.headers.get("elevenlabs-signature")
    if secret:
        if not verify_elevenlabs_signature(body=raw, signature_header=sig, secret=secret):
            raise PlatformError("webhook_signature", "Invalid ElevenLabs signature", status_code=401)
    elif not settings.auth_disabled:
        raise PlatformError(
            "webhook_misconfigured",
            "ELEVENLABS_WEBHOOK_SECRET required when AUTH_DISABLED=false",
            status_code=500,
        )

    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except Exception as exc:
        raise PlatformError("invalid_json", str(exc), status_code=400) from exc

    event_type = str(payload.get("type") or "")
    if event_type and event_type not in {"post_call_transcription", "post_call_audio"}:
        return {"ok": True, "ignored": True, "type": event_type}
    if event_type == "post_call_audio":
        return {"ok": True, "ignored": True, "reason": "audio_only"}

    return await post_call_service.process(
        raw_payload=payload if isinstance(payload, dict) else {},
        source="elevenlabs_webhook",
    )


@router.get("/calls/dispatch")
async def list_dispatches(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    return {"items": ops_store.list_dispatches(50)}


@router.get("/segmentation")
async def ops_segmentation(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    return segmentation_service.scoreboard()


class WhatsAppSendBody(BaseModel):
    phone: str = Field(min_length=8, max_length=20)
    text: str = Field(default="", max_length=500)
    template: str | None = None
    # flow = plantilla vía flujo LIWA (recomendado); text = solo ventana 24h
    kind: str = Field(default="flow", pattern="^(flow|text)$")
    flow_id: str | None = None
    first_name: str = Field(default="Asociado", max_length=80)


@router.get("/whatsapp/flows")
async def whatsapp_flows(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    settings = get_settings()
    if not settings.liwa_live_enabled():
        return {
            "ok": True,
            "mode": "mock",
            "items": [
                {"id": settings.liwa_default_flow_id or "mock_reno", "name": "Renovaciones (mock)"}
            ],
            "default_flow_id": settings.liwa_default_flow_id,
        }
    return await liwa_whatsapp_service.list_flows()


@router.post("/whatsapp/send")
async def whatsapp_send(
    body: WhatsAppSendBody,
    _ctx: AuthContext = Depends(require_auth),
) -> dict[str, Any]:
    decision = compliance_service.evaluate(phone=body.phone, channel="whatsapp")
    if not decision.allowed:
        raise PlatformError(
            "compliance_blocked",
            ",".join(decision.reasons) or "blocked",
            status_code=403,
        )
    settings = get_settings()
    if settings.liwa_live_enabled():
        if body.kind == "text" and not (body.text or "").strip():
            raise PlatformError("validation_error", "text required for kind=text", status_code=422)
        result = await liwa_whatsapp_service.send(
            phone=body.phone,
            text=body.text or "",
            first_name=body.first_name,
            template=body.template,
            kind=body.kind,
            flow_id=body.flow_id,
        )
        if not result.get("ok"):
            detail = result.get("error") or "LIWA send failed"
            msg = result.get("message")
            if isinstance(msg, dict) and msg.get("error"):
                detail = str(msg.get("error"))
            raise PlatformError(
                "liwa_send_failed",
                str(detail),
                status_code=502,
            )
    else:
        result = whatsapp_mock_service.send_text(
            phone=body.phone,
            text=body.text or f"[flow:{body.flow_id or settings.liwa_default_flow_id}]",
            template=body.template,
        )
    result["compliance"] = compliance_service.as_dict(decision)
    return result


class CrmMoveBody(BaseModel):
    lead_id: str
    to_column: str
    tipificacion: str | None = None
    funnel: str | None = None


@router.post("/crm/move")
async def crm_move(body: CrmMoveBody, _ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    try:
        lead = crm_service.move(
            lead_id=body.lead_id, to_column=body.to_column, tipificacion=body.tipificacion
        )
    except ValueError as exc:
        raise PlatformError("crm_transition_blocked", str(exc), status_code=400) from exc
    if body.funnel:
        lead["funnel"] = body.funnel
        ops_store.upsert_crm_lead(lead)
    return lead


class CrmCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    funnel: str = "Renovación"
    phone: str | None = None


@router.post("/crm/leads")
async def crm_create_lead(
    body: CrmCreateBody, _ctx: AuthContext = Depends(require_auth)
) -> dict[str, Any]:
    return crm_service.create_lead(name=body.name, funnel=body.funnel, phone=body.phone)


class ConversationClaimBody(BaseModel):
    conversation_id: str
    advisor: str = "Admin Coopfuturo"


@router.post("/conversations/claim")
async def claim_conversation(
    body: ConversationClaimBody, _ctx: AuthContext = Depends(require_auth)
) -> dict[str, Any]:
    claim = {
        "id": body.conversation_id,
        "advisor": body.advisor,
        "status": "human_control",
    }
    return ops_store.upsert_conversation_claim(claim)


class ConversationReleaseBody(BaseModel):
    conversation_id: str


@router.post("/conversations/release")
async def release_conversation(
    body: ConversationReleaseBody, _ctx: AuthContext = Depends(require_auth)
) -> dict[str, Any]:
    removed = ops_store.delete_conversation_claim(body.conversation_id)
    return {"ok": True, "released": removed, "conversation_id": body.conversation_id}


class ConversationMessageBody(BaseModel):
    conversation_id: str
    text: str = Field(min_length=1, max_length=2000)
    role: str = Field(default="advisor", pattern="^(advisor|bot|user)$")


@router.post("/conversations/messages")
async def post_conversation_message(
    body: ConversationMessageBody, _ctx: AuthContext = Depends(require_auth)
) -> dict[str, Any]:
    claims = {c["id"]: c for c in ops_store.list_conversation_claims()}
    if body.conversation_id not in claims and body.role == "advisor":
        raise PlatformError(
            "conversation_not_claimed",
            "Claim the conversation before sending advisor messages",
            status_code=409,
        )
    msg = {
        "id": f"m_{uuid4().hex[:10]}",
        "role": "bot" if body.role == "advisor" else body.role,
        "text": body.text,
        "at": "ahora",
        "source": body.role,
    }
    saved = ops_store.append_conversation_message(body.conversation_id, msg)
    return {"ok": True, "message": saved}


@router.get("/conversations")
async def ops_conversations(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    data = _load("conversation.json")
    claims = {c["id"]: c for c in ops_store.list_conversation_claims()}
    by_id: dict[str, Any] = {c["id"]: dict(c) for c in (data.get("conversations") or [])}
    for t in ops_store.list_conversation_threads():
        tid = t.get("id")
        if not tid:
            continue
        if tid in by_id:
            by_id[tid] = {**by_id[tid], **t, "messages": by_id[tid].get("messages") or []}
        else:
            by_id[tid] = t

    convs = []
    for cid, c in by_id.items():
        extra_msgs = ops_store.list_conversation_messages(cid)
        base_msgs = list(c.get("messages") or [])
        if extra_msgs:
            base_msgs = [*base_msgs, *extra_msgs]
        claim = claims.get(cid)
        row = {**c, "messages": base_msgs}
        if claim:
            row["claimedBy"] = claim.get("advisor")
            row["botPaused"] = True
            row["botActive"] = False
        convs.append(row)

    if pii_masking_enabled():
        convs = [mask_conversation(c) for c in convs]

    return {
        **data,
        "conversations": convs,
        "activeCount": len(convs),
        "pii_masked": pii_masking_enabled(),
    }


class DocumentBody(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = "application/pdf"
    size_bytes: int = Field(default=0, ge=0)
    contact_phone: str | None = None
    kind: str = "orden_matricula"


@router.post("/documents")
async def register_document(
    body: DocumentBody, _ctx: AuthContext = Depends(require_auth)
) -> dict[str, Any]:
    return documents_service.register(
        filename=body.filename,
        content_type=body.content_type,
        size_bytes=body.size_bytes,
        contact_phone=body.contact_phone,
        kind=body.kind,
    )


@router.post("/documents/upload")
async def upload_document(
    _ctx: AuthContext = Depends(require_auth),
    file: UploadFile = File(...),
    contact_phone: str | None = Form(default=None),
    kind: str = Form(default="orden_matricula"),
) -> dict[str, Any]:
    raw = await file.read()
    return documents_service.register(
        filename=file.filename or "documento.pdf",
        content_type=file.content_type or "application/pdf",
        size_bytes=len(raw),
        contact_phone=contact_phone,
        kind=kind,
        content=raw,
    )


@router.get("/documents")
async def list_documents(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    data = documents_service.list()
    if pii_masking_enabled():
        from pilot_core.modules.pii import mask_phone

        items = []
        for d in data.get("items") or []:
            row = dict(d)
            if row.get("contact_phone"):
                row["contact_phone"] = mask_phone(row.get("contact_phone"))
            items.append(row)
        data = {**data, "items": items}
    return data


@router.get("/reports/{report_id}")
async def get_report(report_id: str, _ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    c = ops_store.counts()
    dashboard = analytics_service.overlay_dashboard(_load("dashboard.json"))
    payloads = {
        "semanal": {
            "id": "semanal",
            "title": "Semanal piloto",
            "kpis": dashboard.get("kpis"),
            "ops": dashboard.get("ops"),
            "store": c,
        },
        "funnel": {
            "id": "funnel",
            "title": "Funnel Renovación",
            "funnel": dashboard.get("funnelRenovacion"),
        },
        "asesores": {
            "id": "asesores",
            "title": "Productividad asesores",
            "handoffs": ops_store.list_handoffs(50),
            "claims": ops_store.list_conversation_claims(),
        },
        "cumplimiento": {
            "id": "cumplimiento",
            "title": "Cumplimiento",
            "opt_outs": compliance_service.list_suppressed(),
            "opt_outs_total": len(compliance_service.list_suppressed()),
            "dispatches": ops_store.list_dispatches(50),
            "window": "08:00-20:00 COT",
        },
    }
    if report_id not in payloads:
        raise PlatformError("report_not_found", report_id, status_code=404)
    return {"ok": True, "format": "json", "report": payloads[report_id]}


@router.get("/settings")
async def get_settings_api(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    stored = ops_store.all_settings()
    ui_defaults: dict[str, Any] = {"pii_masking": True}
    s = get_settings()
    defaults: dict[str, Any] = {
        "channels": {
            "voz_enabled": True,
            "whatsapp_enabled": True,
            "ventana_8_20": True,
            "grabacion": True,
            "identificacion": True,
        },
        "dialer": {
            "base_url": getattr(s, "dialer_base_url", "") or "",
            "default_phone_number_id": getattr(s, "dialer_default_phone_number_id", "") or "",
        },
        "whatsapp": {
            "mode": "real" if s.liwa_live_enabled() else "mock",
            "provider": "liwa" if s.liwa_live_enabled() else "liwa_mock",
            "base_url": (s.liwa_base_url or "").rstrip("/"),
            "default_flow_id": s.liwa_default_flow_id or "",
            "default_kind": "flow",
            "handoff_tag": s.liwa_handoff_tag or "",
        },
        "documents": {
            "storage_backend": s.documents_storage_backend or "filesystem",
            "local_root": s.documents_local_root or "",
        },
        "core": {
            "mode": "live" if (s.core_base_url or "").strip() else "mock",
            "base_url": (s.core_base_url or "").rstrip("/"),
        },
        "ui": ui_defaults,
        "agent_config": agent_config_service.get(),
    }
    merged: dict[str, Any] = {**defaults, **stored, "agent_config": agent_config_service.get()}
    ui_raw = merged.get("ui")
    ui: dict[str, Any] = ui_raw if isinstance(ui_raw, dict) else {}
    merged["ui"] = {**ui_defaults, **ui}
    # Always reflect runtime LIWA mode (not overwritten by stale SQLite).
    merged["whatsapp"] = defaults["whatsapp"]
    return merged


class SettingsBody(BaseModel):
    channels: dict[str, Any] | None = None
    dialer: dict[str, Any] | None = None
    agent_config: dict[str, Any] | None = None
    ui: dict[str, Any] | None = None


@router.put("/settings")
async def put_settings(
    body: SettingsBody, _ctx: AuthContext = Depends(require_auth)
) -> dict[str, Any]:
    if body.channels is not None:
        ops_store.set_setting("channels", body.channels)
        if body.channels.get("ventana_8_20") is False:
            compliance_service.window_start = time(0, 0)
            compliance_service.window_end = time(23, 59)
        elif body.channels.get("ventana_8_20") is True:
            compliance_service.window_start = time(8, 0)
            compliance_service.window_end = time(20, 0)
    if body.dialer is not None:
        ops_store.set_setting("dialer", body.dialer)
        s = get_settings()
        if "base_url" in body.dialer:
            object.__setattr__(s, "dialer_base_url", str(body.dialer.get("base_url") or ""))
        if "default_phone_number_id" in body.dialer:
            object.__setattr__(
                s,
                "dialer_default_phone_number_id",
                str(body.dialer.get("default_phone_number_id") or ""),
            )
    if body.agent_config is not None:
        agent_config_service.save(body.agent_config)
    if body.ui is not None:
        prev = ops_store.get_setting("ui") or {}
        if not isinstance(prev, dict):
            prev = {}
        ops_store.set_setting("ui", {**prev, **body.ui})
    return await get_settings_api(_ctx)


@router.get("/core/associate/{document_id}")
async def core_lookup(
    document_id: str, _ctx: AuthContext = Depends(require_auth)
) -> dict[str, Any]:
    return await core_adapter_service.lookup_associate(document_id)


@router.get("/auth/status")
async def auth_status(_ctx: AuthContext = Depends(require_auth)) -> dict[str, Any]:
    """OIDC readiness probe for ops UI / deploy checks."""
    s = get_settings()
    configured = bool(s.oidc_issuer and s.oidc_audience and (s.oidc_jwks_url or s.oidc_jwks_static_json))
    return {
        "ok": True,
        "app_env": s.app_env,
        "auth_disabled": s.auth_disabled,
        "oidc_configured": configured,
        "oidc_issuer": s.oidc_issuer or None,
        "oidc_audience": s.oidc_audience or None,
        "jwks": "static" if s.oidc_jwks_static_json else ("url" if s.oidc_jwks_url else None),
        "ready_for_production_auth": configured and not s.auth_disabled and s.app_env in ("staging", "production"),
    }


class E2ERenovacionBody(BaseModel):
    phone: str = Field(min_length=8, max_length=20)
    first_name: str = Field(default="Prueba", max_length=80)
    skip_voice: bool = False
    skip_whatsapp: bool = False
    flow_id: str | None = None
    agency_tag: str | None = None


@router.post("/e2e/renovacion")
async def e2e_renovacion(
    body: E2ERenovacionBody,
    ctx: AuthContext = Depends(require_auth),
) -> dict[str, Any]:
    """Demo path: voz → WA flujo → documento → handoff → CRM tip."""
    steps: dict[str, Any] = {}
    settings = get_settings()

    decision = compliance_service.evaluate(phone=body.phone, channel="voz")
    steps["compliance"] = compliance_service.as_dict(decision)
    if not decision.allowed:
        raise PlatformError("compliance_blocked", ",".join(decision.reasons), status_code=403)

    if not body.skip_voice:
        steps["voice"] = await orchestration_service.attempt_call(
            phone=body.phone,
            first_name=body.first_name,
            flow="A",
            tenant_id=ctx.tenant_id,
        )
    else:
        steps["voice"] = {"skipped": True}

    if not body.skip_whatsapp:
        if settings.liwa_live_enabled():
            steps["whatsapp"] = await liwa_whatsapp_service.send(
                phone=body.phone,
                first_name=body.first_name,
                kind="flow",
                flow_id=body.flow_id,
                text="E2E renovacion PULSO",
            )
        else:
            steps["whatsapp"] = whatsapp_mock_service.send_text(
                phone=body.phone, text="E2E renovacion mock"
            )
    else:
        steps["whatsapp"] = {"skipped": True}

    # Minimal PDF bytes for storage demo
    pdf_bytes = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
    steps["document"] = documents_service.register(
        filename="orden_matricula_e2e.pdf",
        content_type="application/pdf",
        size_bytes=len(pdf_bytes),
        contact_phone=body.phone,
        kind="orden_matricula",
        content=pdf_bytes,
    )

    handoff_body = CreateHandoffBody(
        name=body.first_name,
        segment="Renovacion",
        motivo="E2E renovacion — doc validado",
        priority="alta",
        phone=body.phone,
        agency_tag=body.agency_tag,
    )
    steps["handoff"] = await create_handoff(handoff_body, ctx)

    try:
        lead = crm_service.create_lead(
            name=body.first_name, funnel="Renovación", phone=body.phone
        )
        lead_id = str(lead.get("id") or "")
        if lead_id:
            steps["crm"] = crm_service.move(
                lead_id=lead_id, to_column="contactado", tipificacion=None
            )
        else:
            steps["crm"] = lead
    except Exception as exc:  # noqa: BLE001
        steps["crm"] = {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "phone": body.phone,
        "steps": steps,
    }


class BatchAttemptBody(BaseModel):
    campaign_id: str | None = None
    flow: str = Field(default="A", pattern="^[AB]$")
    limit: int = Field(default=20, ge=1, le=200)


@router.post("/orchestration/batch")
async def orchestration_batch(
    body: BatchAttemptBody, ctx: AuthContext = Depends(require_auth)
) -> dict[str, Any]:
    contacts = ops_store.list_contacts(body.limit)
    results = []
    for c in contacts:
        r = await orchestration_service.attempt_call(
            phone=c["phone"],
            first_name=c.get("first_name") or "Asociado",
            campaign_id=body.campaign_id,
            flow=body.flow,
            tenant_id=ctx.tenant_id,
        )
        results.append({"phone": c["phone"], **r})
    ok = sum(1 for x in results if x.get("ok"))
    blocked = sum(1 for x in results if x.get("blocked"))
    return {
        "ok": True,
        "total": len(results),
        "sent_or_queued": ok,
        "blocked": blocked,
        "results": results,
    }

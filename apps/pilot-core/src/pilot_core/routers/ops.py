"""Ops product API - shapes aligned with apps/web MODULES.md (piloto PULSO)."""

from __future__ import annotations

import json
from datetime import time
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from platform_kit.auth import AuthContext
from platform_kit.errors import PlatformError
from pydantic import BaseModel, Field

from pilot_core import ops_store
from pilot_core.modules.activity import humanize_conversation_row
from pilot_core.modules.agent_config.service import agent_config_service
from pilot_core.modules.analytics.service import analytics_service
from pilot_core.modules.campaigns.service import campaigns_service
from pilot_core.modules.compliance.service import compliance_service
from pilot_core.modules.contacts.service import contacts_service
from pilot_core.modules.core_adapter.service import core_adapter_service
from pilot_core.modules.crm.service import crm_service
from pilot_core.modules.documents_service import documents_service
from pilot_core.modules.liwa_inbound import process_liwa_inbound
from pilot_core.modules.liwa_whatsapp import liwa_whatsapp_service
from pilot_core.modules.orchestration.service import orchestration_service
from pilot_core.modules.pii import (
    mask_contact,
    mask_conversation,
    mask_crm_card,
    mask_dispatch,
    mask_handoff_row,
    mask_phone,
    mask_phone_fields,
    mask_segmentation_point,
    should_mask_pii,
)
from pilot_core.modules.post_call.service import (
    extract_conversation_id,
    post_call_service,
    verify_elevenlabs_signature,
)
from pilot_core.modules.segmentation.service import segmentation_service
from pilot_core.modules.whatsapp_mock import whatsapp_mock_service
from pilot_core.ops_auth import (
    OPS_MANAGE,
    OPS_OPERATE,
    can_manage_conversation,
    require_ops_auth,
    require_ops_roles,
)
from pilot_core.settings import get_settings

router = APIRouter(prefix="/ops", tags=["ops-product"])

_FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "ops"
ops_store.init_db()


def _load(name: str) -> dict[str, Any]:
    path = _FIXTURES / name
    return json.loads(path.read_text(encoding="utf-8"))


def empty_dashboard() -> dict[str, Any]:
    """Zero-filled dashboard shell so charts render without smoke/demo numbers."""
    days = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
    zero_spark = [0, 0, 0, 0, 0, 0, 0]
    return {
        "kpis": [
            {
                "id": "contactabilidad",
                "label": "Contactabilidad",
                "value": 0,
                "unit": "%",
                "delta": 0,
                "deltaUnit": "pp",
                "sparkline": list(zero_spark),
            },
            {
                "id": "conversacion",
                "label": "Conversación completada",
                "value": 0,
                "unit": "%",
                "delta": 0,
                "deltaUnit": "pp",
                "sparkline": list(zero_spark),
            },
            {
                "id": "intencion",
                "label": "Intención positiva",
                "value": 0,
                "unit": "%",
                "delta": 0,
                "deltaUnit": "pp",
                "sparkline": list(zero_spark),
            },
            {
                "id": "ordenes",
                "label": "Órdenes recibidas",
                "value": 0,
                "unit": "",
                "delta": 0,
                "deltaUnit": "%",
                "sparkline": list(zero_spark),
            },
            {
                "id": "csat",
                "label": "CSAT",
                "value": 0,
                "unit": "/5",
                "delta": 0,
                "deltaUnit": "",
                "sparkline": list(zero_spark),
            },
        ],
        "contactsByDay": [{"date": d, "voz": 0, "whatsapp": 0} for d in days],
        "funnelRenovacion": [
            {"key": "contactado", "label": "Contactado", "count": 0, "pct": 0},
            {"key": "interesado", "label": "Interesado", "count": 0, "pct": 0},
            {"key": "documento", "label": "Documento", "count": 0, "pct": 0},
            {"key": "transferido", "label": "Transferido", "count": 0, "pct": 0},
            {"key": "renovado", "label": "Renovado", "count": 0, "pct": 0},
        ],
        "baseStatus": [
            {
                "key": "contactados",
                "label": "Contactados",
                "count": 0,
                "pct": 0,
                "color": "success",
            },
            {
                "key": "no_contactados",
                "label": "No contactados",
                "count": 0,
                "pct": 0,
                "color": "muted",
            },
            {
                "key": "no_disponibles",
                "label": "No disponibles",
                "count": 0,
                "pct": 0,
                "color": "warning",
            },
            {"key": "rechazados", "label": "Rechazados", "count": 0, "pct": 0, "color": "danger"},
            {"key": "otros", "label": "Otros", "count": 0, "pct": 0, "color": "info"},
        ],
        "ops": [
            {"id": "llamadas", "label": "Dispatches voz", "value": "0"},
            {"id": "wa", "label": "WhatsApp", "value": "0"},
            {"id": "contactos", "label": "Contactos en store", "value": "0"},
            {"id": "campanas", "label": "Campañas", "value": "0"},
            {"id": "handoffs", "label": "Handoffs", "value": "0"},
            {"id": "crm", "label": "Leads CRM", "value": "0"},
        ],
        "liveEvents": [],
    }


def empty_campaigns() -> dict[str, Any]:
    days = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]
    hours = ["8–10", "10–12", "12–14", "14–16", "16–18", "18–20"]
    return {
        "dayChips": {
            "llamadasHoy": 0,
            "whatsappHoy": 0,
            "reintentos": 0,
            "ventana": "8:00-20:00",
            "ventanaActiva": True,
        },
        "campaigns": [],
        "heatmap": {
            "days": days,
            "hours": hours,
            "values": [[0.0] * len(hours) for _ in days],
            "unitLabel": "Tasa de conversión",
        },
        "ab": None,
    }


def empty_handoff() -> dict[str, Any]:
    return {
        "kpis": [
            {"id": "cola", "label": "Leads en cola", "value": 0, "delta": 0, "deltaUnit": "%"},
            {"id": "sla", "label": "SLA promedio", "value": "0h 00m", "delta": 0, "deltaUnit": "m"},
            {
                "id": "expediente",
                "label": "Expediente completo",
                "value": 0,
                "unit": "%",
                "delta": 0,
                "deltaUnit": "pp",
            },
            {"id": "cerrados", "label": "Cerrados hoy", "value": 0, "delta": 0, "deltaUnit": "%"},
        ],
        "queue": [],
        "byAdvisor": [],
        "quality": {"score": 0, "label": "", "breakdown": []},
    }


def empty_conversations() -> dict[str, Any]:
    return {"conversations": [], "activeCount": 0}


@router.get("/dashboard")
async def ops_dashboard(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
    data = empty_dashboard()
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
                    "kind": (
                        "WhatsApp enviado"
                        if "whatsapp" in str(d.get("mode") or "").lower()
                        else "Llamada enviada"
                    ),
                    "at": "ahora",
                }
            )
        data = {**data, "liveEvents": [*live, *data.get("liveEvents", [])][:12]}
    return analytics_service.overlay_dashboard(data)


@router.get("/campaigns")
async def ops_campaigns(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
    data = empty_campaigns()
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
async def ops_crm(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
    data = crm_service.snapshot()
    if should_mask_pii(_ctx):
        funnels = data.get("funnels") or {}
        for funnel in funnels.values():
            for col in funnel.get("columns") or []:
                col["cards"] = [mask_crm_card(c) for c in (col.get("cards") or [])]
    return data


@router.get("/handoff")
async def ops_handoff(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
    data = empty_handoff()
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
    if should_mask_pii(_ctx):
        data = {
            **data,
            "queue": [mask_handoff_row(r) for r in (data.get("queue") or [])],
        }
    return data


class CreateCampaignBody(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    segment: str = Field(default="Renovacion")
    channels: list[str] = Field(default_factory=lambda: ["voz"])
    total: int = Field(default=0, ge=0, le=100_000)


class ImportContactsBody(BaseModel):
    rows: list[dict[str, Any]] = Field(default_factory=list, max_length=5000)
    commit: bool = False


class CreateHandoffBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    segment: str = "Renovacion"
    motivo: str = "Lead calificado"
    priority: str = "alta"
    phone: str | None = None
    agency_tag: str | None = None
    idempotency_key: str | None = Field(default=None, max_length=120)


class OptOutBody(BaseModel):
    phone: str = Field(min_length=8, max_length=20)


@router.post("/contacts/import")
async def import_contacts(
    body: ImportContactsBody,
    _ctx: AuthContext = Depends(require_ops_roles(*OPS_MANAGE)),
) -> dict[str, Any]:
    if body.commit:
        return contacts_service.commit_valid(body.rows)
    return contacts_service.preview_rows(body.rows)


@router.get("/contacts")
async def list_contacts(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
    data = contacts_service.list_contacts()
    if should_mask_pii(_ctx) and isinstance(data, dict):
        items = data.get("items") or data.get("contacts") or []
        key = "items" if "items" in data else "contacts" if "contacts" in data else None
        if key:
            data = {**data, key: [mask_contact(c) for c in items]}
    return data


@router.post("/campaigns")
async def create_campaign(
    body: CreateCampaignBody,
    _ctx: AuthContext = Depends(require_ops_roles(*OPS_MANAGE)),
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
    ctx: AuthContext = Depends(require_ops_roles(*OPS_MANAGE)),
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
    _ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE)),
) -> dict[str, Any]:
    """AUD-021: durable handoff saga — claim → thread → LIWA → persist."""
    from pilot_core.modules.product_flow import resolve_product_flow

    flow_guess = "B" if "reactiva" in (body.segment or "").lower() else "A"
    product = resolve_product_flow(flow_guess)
    agency_tag = body.agency_tag or str(product["liwa_handoff_tag"])
    idem = (body.idempotency_key or "").strip() or (
        f"handoff:{(body.phone or '').strip()}:{agency_tag}:{body.segment}"
    )
    claimed, saga = ops_store.claim_saga(
        "handoff",
        idem,
        {"steps": {}, "phone": body.phone, "name": body.name},
    )
    if not claimed and saga and saga.get("status") == "completed":
        raw_result = saga.get("result")
        result: dict[str, Any] = raw_result if isinstance(raw_result, dict) else dict(saga)
        return {**result, "ok": True, "idempotent": True, "saga_id": saga.get("id")}
    if not claimed and saga and saga.get("status") == "processing":
        raise PlatformError(
            "saga_in_flight",
            "Handoff already being processed",
            status_code=409,
            details={"saga_id": saga.get("id")},
        )
    assert saga is not None
    steps: dict[str, Any] = dict(saga.get("steps") or {})
    try:
        cid = str(steps.get("conversation_id") or f"cv_{uuid4().hex[:10]}")
        hid = str(steps.get("handoff_id") or f"h_{uuid4().hex[:10]}")
        if not steps.get("thread_done"):
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
            steps["thread_done"] = True
            steps["conversation_id"] = cid
            steps["handoff_id"] = hid
            saga["steps"] = steps
            ops_store.save_saga(saga)

        raw_liwa = steps.get("liwa")
        liwa_meta: dict[str, Any] = (
            dict(raw_liwa) if isinstance(raw_liwa, dict) else {"synced": False}
        )
        settings = get_settings()
        if body.phone and settings.liwa_live_enabled() and not liwa_meta.get("synced"):
            decision = compliance_service.evaluate(phone=body.phone, channel="whatsapp")
            liwa_meta["compliance"] = compliance_service.as_dict(decision)
            if not decision.allowed:
                liwa_meta.update(
                    {
                        "ok": False,
                        "synced": False,
                        "blocked": True,
                        "error": "compliance_blocked",
                        "reasons": decision.reasons,
                    }
                )
            else:
                liwa_meta = dict(
                    await liwa_whatsapp_service.handoff_to_agency(
                        phone=body.phone,
                        first_name=body.name.split()[0] if body.name else "Asociado",
                        motivo=body.motivo,
                        tag_name=agency_tag,
                    )
                )
                liwa_meta["synced"] = bool(liwa_meta.get("ok"))
                liwa_meta["compliance"] = compliance_service.as_dict(decision)
            steps["liwa"] = liwa_meta
            saga["steps"] = steps
            ops_store.save_saga(saga)
        elif not body.phone or not settings.liwa_live_enabled():
            raw_skip = steps.get("liwa")
            liwa_meta = (
                dict(raw_skip) if isinstance(raw_skip, dict) else {"synced": False, "skipped": True}
            )
            steps["liwa"] = liwa_meta

        # AUD2-009: LIWA live handoff that did not sync must not complete the saga.
        liwa_required = bool(body.phone and settings.liwa_live_enabled())
        if (
            liwa_required
            and not liwa_meta.get("synced")
            and not liwa_meta.get("blocked")
            and not liwa_meta.get("skipped")
        ):
            saga["status"] = "failed"
            saga["error"] = str(liwa_meta.get("error") or "liwa_handoff_failed")[:200]
            saga["steps"] = steps
            ops_store.save_saga(saga)
            raise PlatformError(
                "liwa_handoff_failed",
                str(liwa_meta.get("error") or "LIWA handoff failed"),
                status_code=502,
                details={"liwa": liwa_meta, "saga_id": saga.get("id")},
            )

        if not steps.get("persisted"):
            entry: dict[str, Any] = {
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
                "saga_id": saga.get("id"),
            }
            try:
                entry = ops_store.insert_handoff(entry)
            except Exception:  # noqa: BLE001 — resume if row already exists
                prior_ho = steps.get("handoff")
                if isinstance(prior_ho, dict):
                    entry = prior_ho
            steps["persisted"] = True
            steps["handoff"] = entry
            saga["steps"] = steps
            saga["status"] = "completed"
            saga["result"] = entry
            ops_store.save_saga(saga)
            return entry
        prior_done = steps.get("handoff")
        entry = prior_done if isinstance(prior_done, dict) else {}
        saga["status"] = "completed"
        saga["result"] = entry
        ops_store.save_saga(saga)
        return entry
    except PlatformError:
        raise
    except Exception as exc:  # noqa: BLE001
        saga["status"] = "failed"
        saga["error"] = str(exc)[:200]
        saga["steps"] = steps
        ops_store.save_saga(saga)
        raise


@router.post("/compliance/opt-out")
async def opt_out(
    body: OptOutBody, _ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE))
) -> dict[str, Any]:
    return {"ok": True, **compliance_service.suppress(body.phone)}


@router.get("/compliance/opt-outs")
async def list_opt_outs(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
    phones = compliance_service.list_suppressed()
    if should_mask_pii(_ctx):
        phones = [mask_phone(p) for p in phones]
    return {"items": phones, "total": len(phones), "pii_masked": should_mask_pii(_ctx)}


class DispatchCallBody(BaseModel):
    phone: str = Field(min_length=8, max_length=20, description="E.164 preferred")
    first_name: str = Field(default="Asociado", max_length=80)
    campaign_id: str | None = None
    agent_phone_number_id: str | None = None
    flow: str = Field(default="A", pattern="^[AB]$")


@router.post("/calls/dispatch")
async def dispatch_call(
    body: DispatchCallBody,
    ctx: AuthContext = Depends(require_ops_roles(*OPS_MANAGE)),
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
        description="TipificaciÃ³n: interesado|renovar|reactivar|no_interes|voicemail|...",
    )
    flow: str = Field(default="A", pattern="^[AB]$")
    skip_whatsapp: bool = False
    conversation_id: str | None = None
    dispatch_id: str | None = None


@router.post("/calls/complete")
async def complete_call(
    body: CallCompleteBody,
    _ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE)),
) -> dict[str, Any]:
    """Post-llamada: tipifica intenciÃ³n y, si continÃºa, envÃ­a flujo WhatsApp (A/B)."""
    return await post_call_service.process(
        phone=body.phone,
        first_name=body.first_name,
        intent=body.intent,
        flow=body.flow,
        skip_whatsapp=body.skip_whatsapp,
        conversation_id=body.conversation_id,
        dispatch_id=body.dispatch_id,
        source="ops",
    )


_WEBHOOK_MAX_BYTES = 2 * 1024 * 1024


async def _read_body_capped(request: Request, *, max_bytes: int) -> bytes:
    """AUD-007: stream body with hard cap before HMAC / JSON parse."""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                raise PlatformError(
                    "payload_too_large",
                    "webhook body exceeds size limit",
                    status_code=413,
                )
        except ValueError:
            pass
    chunks: list[bytes] = []
    total = 0
    async for piece in request.stream():
        if not piece:
            continue
        total += len(piece)
        if total > max_bytes:
            raise PlatformError(
                "payload_too_large",
                "webhook body exceeds size limit",
                status_code=413,
            )
        chunks.append(piece)
    return b"".join(chunks)


@router.post("/webhooks/liwa")
async def liwa_inbound_webhook(request: Request) -> dict[str, Any]:
    """LIWA Webhooks / API externa → espejo Conversaciones, CSAT, opt-out, handoff AG_*."""
    settings = get_settings()
    secret = (settings.liwa_webhook_secret or "").strip()
    require_secret = settings.app_env in ("staging", "production") or not settings.auth_disabled
    if require_secret and not secret:
        raise PlatformError(
            "webhook_misconfigured",
            "LIWA_WEBHOOK_SECRET is required",
            status_code=503,
        )

    provided = (
        request.headers.get("x-liwa-webhook-secret")
        or request.headers.get("x-webhook-secret")
        or ""
    ).strip()
    if secret and provided != secret:
        raise PlatformError("webhook_secret", "Invalid LIWA webhook secret", status_code=401)

    raw = await _read_body_capped(request, max_bytes=_WEBHOOK_MAX_BYTES)
    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except Exception as exc:
        raise PlatformError("invalid_json", "Invalid JSON body", status_code=400) from exc
    if not isinstance(payload, dict):
        raise PlatformError("invalid_json", "JSON object required", status_code=400)

    tenant = str(payload.get("tenant_id") or "").strip() or settings.liwa_webhook_tenant()
    with ops_store.tenant_scope(tenant):
        result = await process_liwa_inbound(payload)
    return result


class LiwaSimulateBody(BaseModel):
    event: str = Field(
        default="document_received",
        description="document_received | prequal_completed | handoff_requested | csat | opt_out | message",
    )
    phone: str = Field(min_length=7, max_length=32)
    first_name: str = "Asociado"
    name: str | None = None
    ciudad: str | None = "Barranquilla"
    text: str | None = None
    score: int | None = Field(default=None, ge=1, le=5)
    tenant_id: str = "coopfuturo"


@router.post("/laboratorio/liwa-event")
async def simulate_liwa_event(
    body: LiwaSimulateBody, _ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE))
) -> dict[str, Any]:
    """Laboratorio: simular webhook LIWA sin configurar nodos (mismo path que producción)."""
    payload: dict[str, Any] = {
        "event": body.event,
        "phone": body.phone,
        "first_name": body.name or body.first_name,
        "name": body.name or body.first_name,
        "tenant_id": body.tenant_id,
    }
    if body.ciudad:
        payload["ciudad"] = body.ciudad
    if body.text:
        payload["text"] = body.text
    if body.score is not None:
        payload["score"] = body.score
    with ops_store.tenant_scope(body.tenant_id or get_settings().liwa_webhook_tenant()):
        return await process_liwa_inbound(payload)


@router.post("/webhooks/elevenlabs/post-call")
async def elevenlabs_post_call_webhook(request: Request) -> dict[str, Any]:
    """Webhook ElevenLabs `post_call_transcription` → tipificación → WA si interesa."""
    settings = get_settings()
    secret = (settings.elevenlabs_webhook_secret or "").strip()
    # AUD-007: never fail-open outside local auth_disabled development/test.
    require_secret = settings.app_env in ("staging", "production") or not settings.auth_disabled
    if require_secret and not secret:
        raise PlatformError(
            "webhook_misconfigured",
            "ELEVENLABS_WEBHOOK_SECRET is required",
            status_code=503,
        )

    raw = await _read_body_capped(request, max_bytes=_WEBHOOK_MAX_BYTES)
    sig = request.headers.get("elevenlabs-signature")
    if secret and not verify_elevenlabs_signature(body=raw, signature_header=sig, secret=secret):
        raise PlatformError("webhook_signature", "Invalid ElevenLabs signature", status_code=401)

    try:
        payload = json.loads(raw.decode("utf-8") or "{}")
    except Exception as exc:
        raise PlatformError("invalid_json", "Invalid JSON body", status_code=400) from exc

    event_type = str(payload.get("type") or "")
    if event_type and event_type not in {"post_call_transcription", "post_call_audio"}:
        return {"ok": True, "ignored": True, "type": event_type}
    if event_type == "post_call_audio":
        return {"ok": True, "ignored": True, "reason": "audio_only"}

    # AUD2-007: require conversation_id so claims/idempotency can bind the call.
    body = payload if isinstance(payload, dict) else {}
    if not extract_conversation_id(body):
        raise PlatformError(
            "validation_error",
            "conversation_id required for post-call webhook",
            status_code=422,
        )

    result = await post_call_service.process(
        raw_payload=body,
        source="elevenlabs_webhook",
    )
    # Providers that only retry on non-2xx need a 5xx for retryable failures.
    if result.get("in_flight"):
        raise PlatformError(
            "post_call_in_flight",
            "Post-call already being processed",
            status_code=409,
            details=result if isinstance(result, dict) else None,
        )
    if (
        result.get("ok") is False
        and (result.get("status") == "failed" or result.get("retryable") is True)
        and result.get("retryable") is not False
    ):
        raise PlatformError(
            "post_call_failed",
            str(result.get("error") or "post_call_failed"),
            status_code=502,
            details=result if isinstance(result, dict) else None,
        )
    return result


@router.get("/calls/dispatch")
async def list_dispatches(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
    items = ops_store.list_dispatches(50)
    if should_mask_pii(_ctx):
        items = [mask_dispatch(d) for d in items]
    return {"items": items, "pii_masked": should_mask_pii(_ctx)}


@router.get("/segmentation")
async def ops_segmentation(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
    data = segmentation_service.scoreboard()
    if should_mask_pii(_ctx):
        points = data.get("points") or data.get("items") or []
        key = "points" if "points" in data else "items" if "items" in data else None
        if key:
            data = {**data, key: [mask_segmentation_point(p) for p in points]}
    return data


class WhatsAppSendBody(BaseModel):
    phone: str = Field(min_length=8, max_length=20)
    text: str = Field(default="", max_length=500)
    template: str | None = None
    # flow = plantilla vÃ­a flujo LIWA (recomendado); text = solo ventana 24h
    kind: str = Field(default="flow", pattern="^(flow|text)$")
    flow_id: str | None = None
    first_name: str = Field(default="Asociado", max_length=80)


@router.get("/whatsapp/flows")
async def whatsapp_flows(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
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
    _ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE)),
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
        # LIWA often returns HTTP 200 + success=true without message_id (AUD-016 →
        # accepted_pending). That is a real handoff, not a send failure.
        delivery = str(result.get("delivery") or "")
        msg = result.get("message") if isinstance(result.get("message"), dict) else {}
        wa_status = str(msg.get("status") or delivery)
        if not result.get("ok") and wa_status not in {"accepted_pending", "queued_mock"}:
            detail = result.get("error") or "LIWA send failed"
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


def _pending_row(pc: dict[str, Any]) -> dict[str, Any]:
    raw_product = pc.get("product")
    product = raw_product if isinstance(raw_product, dict) else {}
    raw_wa = pc.get("whatsapp")
    whatsapp = raw_wa if isinstance(raw_wa, dict) else {}
    status = str(pc.get("whatsapp_status") or "pending_review")
    return {
        "id": pc.get("id") or pc.get("conversation_id"),
        "conversation_id": pc.get("conversation_id"),
        "phone": pc.get("phone"),
        "first_name": pc.get("first_name"),
        "intent": pc.get("intent"),
        "flow": pc.get("flow"),
        "flow_id": product.get("liwa_flow_id"),
        "segment": product.get("segment"),
        "status": status,
        "whatsapp_status": status,
        "whatsapp_sent": bool(pc.get("whatsapp_sent")),
        "wants_whatsapp": bool(pc.get("wants_whatsapp")),
        "post_call_id": pc.get("id"),
        "whatsapp": whatsapp,
        "_created_at": pc.get("_created_at"),
    }


@router.get("/whatsapp/pending")
async def whatsapp_pending(
    scope: str = "pending",
    _ctx: AuthContext = Depends(require_ops_auth),
) -> dict[str, Any]:
    """Cola de revisión WhatsApp post-llamada (pending) o historial (scope=review)."""
    # Terminal / already-handed statuses must not reappear as "send again".
    done = {
        "skipped",
        "sent",
        "sent_manual",
        "sent_mock",
        "queued_mock",
        "accepted_pending",
    }
    rows = [pc for pc in ops_store.list_post_calls(300) if pc.get("wants_whatsapp")]
    if scope != "review":
        rows = [
            pc
            for pc in rows
            if not pc.get("whatsapp_sent") and str(pc.get("whatsapp_status") or "") not in done
        ]
    items = [_pending_row(pc) for pc in rows]
    if should_mask_pii(_ctx):
        items = [mask_phone_fields(row) for row in items]
    return {
        "items": items,
        "count": len(items),
        "scope": "review" if scope == "review" else "pending",
        "pii_masked": should_mask_pii(_ctx),
    }


class WhatsAppPendingBody(BaseModel):
    conversation_id: str | None = None
    phone: str | None = Field(default=None, max_length=20)
    flow_id: str | None = None


@router.post("/whatsapp/pending/send")
async def whatsapp_pending_send(
    body: WhatsAppPendingBody,
    _ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE)),
) -> dict[str, Any]:
    """Envía manualmente el WhatsApp de un lead pendiente (dispara el flujo LIWA)."""
    # AUD2-006: require conversation_id + idempotent guards against double send.
    if not body.conversation_id:
        raise PlatformError("validation_error", "conversation_id requerido", status_code=422)
    pc = ops_store.get_post_call_by_conversation(body.conversation_id)
    if not pc:
        raise PlatformError("not_found", "post_call no encontrado", status_code=404)
    status = str(pc.get("whatsapp_status") or "")
    terminal = {
        "skipped",
        "sent",
        "sent_manual",
        "sent_mock",
        "queued_mock",
        "accepted_pending",
    }
    if pc.get("whatsapp_sent") or status in terminal:
        return {
            "ok": True,
            "idempotent": True,
            "conversation_id": body.conversation_id,
            "phone": pc.get("phone"),
            "whatsapp_status": status or ("sent" if pc.get("whatsapp_sent") else None),
            "whatsapp": pc.get("whatsapp"),
        }
    raw_product = pc.get("product") if pc else None
    product = raw_product if isinstance(raw_product, dict) else {}
    # Prefer store phone over client-supplied (AUD2-007 binding).
    phone = (pc or {}).get("phone") or body.phone
    if not phone:
        raise PlatformError("validation_error", "phone requerido en post_call", status_code=422)
    decision = compliance_service.evaluate(phone=phone, channel="whatsapp")
    if not decision.allowed:
        raise PlatformError(
            "compliance_blocked", ",".join(decision.reasons) or "blocked", status_code=403
        )
    flow_id = body.flow_id or product.get("liwa_flow_id")
    first_name = (pc or {}).get("first_name") or "Asociado"
    settings = get_settings()
    if settings.liwa_live_enabled():
        result = await liwa_whatsapp_service.send(
            phone=phone,
            first_name=first_name,
            kind="flow",
            flow_id=str(flow_id) if flow_id else None,
            text="",
        )
    else:
        result = whatsapp_mock_service.send_text(phone=phone, text=f"[manual flow:{flow_id}]")
    delivery = str(result.get("delivery") or "")
    if result.get("ok"):
        wa_status = "sent_manual"
        sent = True
    elif delivery == "accepted_pending":
        # Handed to provider without receipt — terminal, do not retry as failed.
        wa_status = "accepted_pending"
        sent = False
    elif delivery == "queued_mock":
        wa_status = "queued_mock"
        sent = False
    else:
        wa_status = "failed"
        sent = False
    pc["whatsapp"] = result.get("message") or result
    pc["whatsapp_sent"] = sent
    pc["whatsapp_status"] = wa_status
    ops_store.insert_post_call(pc)
    return {
        "ok": bool(result.get("ok")) or wa_status in {"accepted_pending", "queued_mock"},
        "conversation_id": body.conversation_id,
        "phone": phone,
        "whatsapp": result,
        "whatsapp_status": wa_status,
    }


@router.post("/whatsapp/pending/skip")
async def whatsapp_pending_skip(
    body: WhatsAppPendingBody,
    _ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE)),
) -> dict[str, Any]:
    """Descarta un lead pendiente (no se enviarÃ¡ WhatsApp)."""
    if not body.conversation_id:
        raise PlatformError("validation_error", "conversation_id requerido", status_code=422)
    pc = ops_store.get_post_call_by_conversation(body.conversation_id)
    if not pc:
        raise PlatformError("not_found", "post_call no encontrado", status_code=404)
    pc["whatsapp_status"] = "skipped"
    ops_store.insert_post_call(pc)
    return {"ok": True, "conversation_id": body.conversation_id, "status": "skipped"}


class CrmMoveBody(BaseModel):
    lead_id: str
    to_column: str
    tipificacion: str | None = None
    funnel: str | None = None


@router.post("/crm/move")
async def crm_move(
    body: CrmMoveBody, _ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE))
) -> dict[str, Any]:
    try:
        lead = crm_service.move(
            lead_id=body.lead_id, to_column=body.to_column, tipificacion=body.tipificacion
        )
    except ValueError as exc:
        # Controlled CRM messages only â€” never raw stack traces.
        msg = str(exc)
        if not msg.startswith(
            ("transition_not_allowed:", "tipificacion_required:", "lead_not_found:")
        ):
            msg = "crm_transition_blocked"
        raise PlatformError("crm_transition_blocked", msg, status_code=400) from exc
    if body.funnel:
        lead["funnel"] = body.funnel
        ops_store.upsert_crm_lead(lead)
    return lead


class CrmCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    funnel: str = "RenovaciÃ³n"
    phone: str | None = None


@router.post("/crm/leads")
async def crm_create_lead(
    body: CrmCreateBody, _ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE))
) -> dict[str, Any]:
    return crm_service.create_lead(name=body.name, funnel=body.funnel, phone=body.phone)


@router.get("/conversations/{conversation_id}/liwa-status")
async def conversation_liwa_status(
    conversation_id: str,
    _ctx: AuthContext = Depends(require_ops_auth),
) -> dict[str, Any]:
    """Poll LIWA contact (live_chat + tags) and sync handoff into PULSO for the demo bridge."""
    from pilot_core.modules.liwa_inbound import _crm_to
    from pilot_core.modules.liwa_whatsapp import is_handoff_tag

    thread = next(
        (t for t in ops_store.list_conversation_threads() if t.get("id") == conversation_id),
        None,
    )
    if thread is None:
        raise PlatformError("not_found", "conversation not found", status_code=404)

    phone = str((thread.get("expediente") or {}).get("phone") or "").strip()
    if not phone:
        # Fallback: conversation ids like cv_573004198710
        digits = "".join(ch for ch in conversation_id if ch.isdigit())
        if len(digits) >= 10:
            phone = f"+{digits}" if digits.startswith("57") else f"+57{digits[-10:]}"

    if not phone:
        return {
            "ok": False,
            "error": "phone_missing",
            "conversation_id": conversation_id,
            "live_chat": False,
            "handoff_detected": False,
            "tags": [],
            "synced": False,
        }

    first_name = str(thread.get("name") or "Asociado")
    settings = get_settings()
    if not settings.liwa_live_enabled():
        return {
            "ok": False,
            "error": "liwa_not_live",
            "conversation_id": conversation_id,
            "phone": phone,
            "live_chat": False,
            "handoff_detected": False,
            "tags": [],
            "mode": "mock",
            "synced": False,
            "inbox_url": "https://chat.liwa.co/?acc=1656233",
        }

    state = await liwa_whatsapp_service.get_contact_handoff_state(
        phone=phone,
        first_name=first_name,
    )
    synced = False
    crm: dict[str, Any] | None = None
    actions: list[str] = []

    if state.get("handoff_detected"):
        already = bool(thread.get("botPaused")) and (
            "Handoff" in (thread.get("tags") or [])
            or any(is_handoff_tag(str(t)) for t in (thread.get("tags") or []))
        )
        handoff_tag = None
        for t in state.get("handoff_tags") or []:
            handoff_tag = str(t)
            break
        agency_hint = state.get("agency_hint")
        tags = list(thread.get("tags") or [])
        if "Handoff" not in tags:
            tags = ["Handoff", *tags]
        if "WhatsApp" not in tags:
            tags = ["WhatsApp", *tags]
        if handoff_tag and handoff_tag not in tags:
            tags = [handoff_tag, *tags]
        snippet = (
            f"Live chat LIWA"
            + (f" · {agency_hint}" if agency_hint else "")
            + (f" · {handoff_tag}" if handoff_tag else "")
        )
        thread = {
            **thread,
            "tags": tags,
            "botActive": False,
            "botPaused": True,
            "channel": "whatsapp",
            "snippet": snippet[:160],
            "expediente": {
                **(thread.get("expediente") or {}),
                "phone": phone,
                "estadoCrm": "Handoff",
            },
            "aiSummary": {
                **(thread.get("aiSummary") or {}),
                "text": snippet[:240],
                "etapa": "asesor",
                "intencion": "handoff",
            },
            "liwa_bridge": {
                "contact_id": state.get("contact_id"),
                "live_chat": state.get("live_chat"),
                "agency_hint": agency_hint,
                "handoff_tags": state.get("handoff_tags") or [],
                "inbox_url": state.get("inbox_url"),
            },
        }
        ops_store.upsert_conversation_thread(thread)
        actions.append("thread_handoff_synced")
        if not already:
            ops_store.insert_handoff(
                {
                    "id": f"ho_{uuid4().hex[:10]}",
                    "name": first_name,
                    "segment": "WhatsApp",
                    "motivo": snippet,
                    "priority": "alta",
                    "agency_tag": handoff_tag or agency_hint or "LIWA_LIVE",
                    "phone": phone,
                    "conversation_id": conversation_id,
                    "status": "queued",
                    "source": "liwa_bridge_poll",
                }
            )
            actions.append("handoff_queued")
            crm = _crm_to(phone=phone, column="transferido", name=first_name)
            actions.append("crm_transferido")
            ops_store.append_conversation_message(
                conversation_id,
                {
                    "id": f"m_{uuid4().hex[:10]}",
                    "role": "bot",
                    "text": (
                        "LIWA: conversación en live chat"
                        + (f" ({agency_hint})" if agency_hint else "")
                        + ". Atiende el chat humano en LIWA."
                    )[:500],
                    "at": "ahora",
                    "source": "liwa_bridge",
                },
            )
            actions.append("bridge_note_appended")
            synced = True
        else:
            synced = True
            actions.append("already_synced")

    return {
        "ok": bool(state.get("ok")),
        "conversation_id": conversation_id,
        "phone": phone,
        "live_chat": bool(state.get("live_chat")),
        "handoff_detected": bool(state.get("handoff_detected")),
        "tags": state.get("tags") or [],
        "handoff_tags": state.get("handoff_tags") or [],
        "agency_hint": state.get("agency_hint"),
        "contact_id": state.get("contact_id"),
        "mode": state.get("mode") or "bot",
        "inbox_url": state.get("inbox_url") or "https://chat.liwa.co/?acc=1656233",
        "synced": synced,
        "actions": actions,
        "crm": crm,
        "error": state.get("error"),
    }


class ConversationClaimBody(BaseModel):
    conversation_id: str
    advisor: str = "Admin Coopfuturo"


@router.post("/conversations/claim")
async def claim_conversation(
    body: ConversationClaimBody, ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE))
) -> dict[str, Any]:
    existing = next(
        (c for c in ops_store.list_conversation_claims() if c.get("id") == body.conversation_id),
        None,
    )
    if existing and not can_manage_conversation(ctx, existing):
        raise PlatformError(
            "conversation_owned",
            "Conversation is claimed by another advisor",
            status_code=403,
        )
    claim = {
        "id": body.conversation_id,
        "advisor": body.advisor,
        "owner_subject": ctx.subject,
        "status": "human_control",
    }
    return ops_store.upsert_conversation_claim(claim)


class ConversationReleaseBody(BaseModel):
    conversation_id: str


@router.post("/conversations/release")
async def release_conversation(
    body: ConversationReleaseBody, ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE))
) -> dict[str, Any]:
    existing = next(
        (c for c in ops_store.list_conversation_claims() if c.get("id") == body.conversation_id),
        None,
    )
    if existing is None:
        return {"ok": True, "released": False, "conversation_id": body.conversation_id}
    if not can_manage_conversation(ctx, existing):
        raise PlatformError(
            "conversation_owned",
            "Only the claiming advisor (or supervisor/admin) can release",
            status_code=403,
        )
    removed = ops_store.delete_conversation_claim(body.conversation_id)
    return {"ok": True, "released": removed, "conversation_id": body.conversation_id}


class ConversationMessageBody(BaseModel):
    conversation_id: str
    text: str = Field(min_length=1, max_length=2000)
    role: str = Field(default="advisor", pattern="^(advisor|bot|user)$")


@router.post("/conversations/messages")
async def post_conversation_message(
    body: ConversationMessageBody, ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE))
) -> dict[str, Any]:
    claims = {c["id"]: c for c in ops_store.list_conversation_claims()}
    claim = claims.get(body.conversation_id)
    if body.role == "advisor":
        if claim is None:
            raise PlatformError(
                "conversation_not_claimed",
                "Claim the conversation before sending advisor messages",
                status_code=409,
            )
        if not can_manage_conversation(ctx, claim):
            raise PlatformError(
                "conversation_owned",
                "Only the claiming advisor (or supervisor/admin) can message",
                status_code=403,
            )
    msg = {
        "id": f"m_{uuid4().hex[:10]}",
        "role": "bot" if body.role == "advisor" else body.role,
        "text": body.text,
        "at": "ahora",
        "source": body.role,
        "author_subject": ctx.subject,
    }
    delivery = "persisted_local"
    channel_acked = False
    liwa_meta: dict[str, Any] | None = None

    if body.role == "advisor":
        thread = next(
            (t for t in ops_store.list_conversation_threads() if t.get("id") == body.conversation_id),
            None,
        )
        phone = str((thread or {}).get("expediente", {}).get("phone") or "").strip()
        first_name = str((thread or {}).get("name") or "Asociado")
        settings = get_settings()
        if phone and settings.liwa_live_enabled():
            decision = compliance_service.evaluate(phone=phone, channel="whatsapp")
            if not decision.allowed:
                raise PlatformError(
                    "compliance_blocked",
                    "; ".join(decision.reasons) or "Contact blocked",
                    status_code=403,
                )
            liwa_res = await liwa_whatsapp_service.send_text(
                phone=phone,
                text=body.text,
                first_name=first_name,
            )
            liwa_meta = liwa_res
            entry = (liwa_res or {}).get("message") or {}
            if liwa_res.get("ok") and entry.get("status") in {"sent", "accepted_pending"}:
                delivery = "liwa_whatsapp"
                channel_acked = entry.get("status") == "sent"
                msg["receipt_id"] = entry.get("receipt_id")
            else:
                raise PlatformError(
                    "liwa_send_failed",
                    str(liwa_res.get("error") or entry.get("error") or "LIWA send failed"),
                    status_code=502,
                    details={"liwa": liwa_res},
                )
        elif phone and not settings.liwa_live_enabled():
            delivery = "mock_local"
            channel_acked = False
            msg["note"] = "LIWA_MODE not real — message stored locally only"

    saved = ops_store.append_conversation_message(body.conversation_id, msg)
    return {
        "ok": True,
        "message": saved,
        "delivery": delivery,
        "channel_acked": channel_acked,
        "liwa": liwa_meta,
    }


@router.get("/conversations")
async def ops_conversations(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
    data = empty_conversations()
    claims = {c["id"]: c for c in ops_store.list_conversation_claims()}
    by_id: dict[str, Any] = {}
    for t in ops_store.list_conversation_threads():
        tid = t.get("id")
        if not tid:
            continue
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
        convs.append(humanize_conversation_row(row))

    if should_mask_pii(_ctx):
        convs = [mask_conversation(c) for c in convs]

    return {
        **data,
        "conversations": convs,
        "activeCount": len(convs),
        "pii_masked": should_mask_pii(_ctx),
    }


class DocumentBody(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = "application/pdf"
    size_bytes: int = Field(default=0, ge=0)
    contact_phone: str | None = None
    kind: str = "orden_matricula"


@router.post("/documents")
async def register_document(
    body: DocumentBody, _ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE))
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
    _ctx: AuthContext = Depends(require_ops_roles(*OPS_OPERATE)),
    file: UploadFile = File(...),
    contact_phone: str | None = Form(default=None),
    kind: str = Form(default="orden_matricula"),
) -> dict[str, Any]:
    # AUD-024: stream with hard cap — never buffer an unbounded body first.
    max_bytes = 10 * 1024 * 1024
    chunks: list[bytes] = []
    total = 0
    while True:
        piece = await file.read(64 * 1024)
        if not piece:
            break
        total += len(piece)
        if total > max_bytes:
            raise PlatformError(
                "payload_too_large",
                "upload exceeds size limit",
                status_code=413,
            )
        chunks.append(piece)
    raw = b"".join(chunks)
    return documents_service.register(
        filename=file.filename or "documento.pdf",
        content_type=file.content_type or "application/pdf",
        size_bytes=len(raw),
        contact_phone=contact_phone,
        kind=kind,
        content=raw,
    )


@router.get("/documents")
async def list_documents(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
    data = documents_service.list()
    if should_mask_pii(_ctx):
        items = []
        for d in data.get("items") or []:
            row = dict(d)
            if row.get("contact_phone"):
                row["contact_phone"] = mask_phone(row.get("contact_phone"))
            items.append(row)
        data = {**data, "items": items}
    return data


@router.get("/reports/{report_id}")
async def get_report(
    report_id: str, _ctx: AuthContext = Depends(require_ops_auth)
) -> dict[str, Any]:
    c = ops_store.counts()
    dashboard = analytics_service.overlay_dashboard(empty_dashboard())
    handoffs = ops_store.list_handoffs(50)
    dispatches = ops_store.list_dispatches(50)
    opt_outs = compliance_service.list_suppressed()
    if should_mask_pii(_ctx):
        handoffs = [mask_handoff_row(h) for h in handoffs]
        dispatches = [mask_dispatch(d) for d in dispatches]
        opt_outs = [mask_phone(p) for p in opt_outs]
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
            "handoffs": handoffs,
            "claims": ops_store.list_conversation_claims(),
        },
        "cumplimiento": {
            "id": "cumplimiento",
            "title": "Cumplimiento",
            "opt_outs": opt_outs,
            "opt_outs_total": len(opt_outs),
            "dispatches": dispatches,
            "window": "08:00-20:00 COT",
        },
    }
    if report_id not in payloads:
        raise PlatformError("report_not_found", report_id, status_code=404)
    return {
        "ok": True,
        "format": "json",
        "report": payloads[report_id],
        "pii_masked": should_mask_pii(_ctx),
    }


@router.get("/settings")
async def get_settings_api(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
    stored = ops_store.all_settings()
    ui_defaults: dict[str, Any] = {"pii_masking": True, "meta_contactos_hoy": 0}
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
            "flow_id_b": s.liwa_flow_id_b or "",
            "default_kind": "flow",
            "handoff_tag": s.liwa_handoff_tag or "",
            "handoff_tag_b": s.liwa_handoff_tag_b or "",
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
    # AUD-005: dialer.base_url is env-owned; ignore any SQLite copy.
    dialer_candidate = merged.get("dialer")
    dialer_raw: dict[str, Any] = dialer_candidate if isinstance(dialer_candidate, dict) else {}
    merged["dialer"] = {
        "default_phone_number_id": str(
            dialer_raw.get("default_phone_number_id")
            or getattr(s, "dialer_default_phone_number_id", "")
            or ""
        ),
        "base_url": getattr(s, "dialer_base_url", "") or "",
    }
    return merged


_CHANNEL_KEYS = frozenset(
    {
        "voz_enabled",
        "whatsapp_enabled",
        "ventana_8_20",
        "grabacion",
        "identificacion",
    }
)


def _sanitize_channels(raw: dict[str, Any], *, prev: dict[str, Any]) -> dict[str, Any]:
    """AUD-028: deep-merge allowlisted channel flags only."""
    base = {
        "voz_enabled": True,
        "whatsapp_enabled": True,
        "ventana_8_20": True,
        "grabacion": True,
        "identificacion": True,
        **{k: bool(prev[k]) for k in _CHANNEL_KEYS if k in prev},
    }
    unknown = set(raw) - _CHANNEL_KEYS
    if unknown:
        raise PlatformError(
            "validation_error",
            f"Unknown channel keys: {', '.join(sorted(unknown))}",
            status_code=422,
        )
    for k in _CHANNEL_KEYS:
        if k in raw:
            base[k] = bool(raw[k])
    return base


class SettingsBody(BaseModel):
    channels: dict[str, Any] | None = None
    dialer: dict[str, Any] | None = None
    agent_config: dict[str, Any] | None = None
    ui: dict[str, Any] | None = None


@router.put("/settings")
async def put_settings(
    body: SettingsBody, _ctx: AuthContext = Depends(require_ops_roles(*OPS_MANAGE))
) -> dict[str, Any]:
    if body.channels is not None:
        # AUD-028: only admin may disable the legal contact window.
        if body.channels.get("ventana_8_20") is False and "admin" not in (_ctx.roles or ()):
            raise PlatformError(
                "forbidden",
                "Only admin can disable ventana_8_20",
                status_code=403,
            )
        prev_ch = ops_store.get_setting("channels") or {}
        if not isinstance(prev_ch, dict):
            prev_ch = {}
        safe_channels = _sanitize_channels(body.channels, prev=prev_ch)
        ops_store.set_setting("channels", safe_channels)
        # Keep in-memory window in sync for legacy callers; evaluate() reads SQLite.
        if safe_channels.get("ventana_8_20") is False:
            compliance_service.window_start = time(0, 0)
            compliance_service.window_end = time(23, 59)
        else:
            compliance_service.window_start = time(8, 0)
            compliance_service.window_end = time(20, 0)
    if body.dialer is not None:
        # AUD-005: dialer.base_url is env-only; API cannot redirect outbound HTTP.
        if "base_url" in body.dialer and body.dialer.get("base_url") not in (None, ""):
            raise PlatformError(
                "dialer_url_immutable",
                "dialer.base_url is configured via DIALER_BASE_URL and cannot be set from the API",
                status_code=403,
            )
        safe_dialer = {k: v for k, v in body.dialer.items() if k != "base_url"}
        prev = ops_store.get_setting("dialer") or {}
        if not isinstance(prev, dict):
            prev = {}
        # Never persist a previously poisoned base_url from older builds.
        merged = {**prev, **safe_dialer}
        merged.pop("base_url", None)
        ops_store.set_setting("dialer", merged)
        s = get_settings()
        if "default_phone_number_id" in safe_dialer:
            object.__setattr__(
                s,
                "dialer_default_phone_number_id",
                str(safe_dialer.get("default_phone_number_id") or ""),
            )
    if body.agent_config is not None:
        agent_config_service.save(body.agent_config)
    if body.ui is not None:
        # AUD-006: only admin may disable PII masking (global).
        if (
            "pii_masking" in body.ui
            and body.ui.get("pii_masking") is False
            and "admin" not in (_ctx.roles or ())
        ):
            raise PlatformError(
                "forbidden",
                "Only admin can disable PII masking",
                status_code=403,
            )
        prev = ops_store.get_setting("ui") or {}
        if not isinstance(prev, dict):
            prev = {}
        allowed_ui = {"pii_masking", "meta_contactos_hoy"}
        incoming = {k: v for k, v in body.ui.items() if k in allowed_ui}
        if "meta_contactos_hoy" in incoming:
            try:
                meta_n = int(incoming["meta_contactos_hoy"])
            except (TypeError, ValueError) as exc:
                raise PlatformError(
                    "validation_error",
                    "meta_contactos_hoy must be an integer >= 0",
                    status_code=422,
                ) from exc
            if meta_n < 0:
                raise PlatformError(
                    "validation_error",
                    "meta_contactos_hoy must be >= 0",
                    status_code=422,
                )
            incoming["meta_contactos_hoy"] = meta_n
        ops_store.set_setting("ui", {**prev, **incoming})
    return await get_settings_api(_ctx)


@router.get("/core/associate/{document_id}")
async def core_lookup(
    document_id: str, _ctx: AuthContext = Depends(require_ops_auth)
) -> dict[str, Any]:
    return await core_adapter_service.lookup_associate(document_id)


@router.get("/auth/status")
async def auth_status(_ctx: AuthContext = Depends(require_ops_auth)) -> dict[str, Any]:
    """OIDC readiness probe for ops UI / deploy checks."""
    s = get_settings()
    configured = s.oidc_configured()
    return {
        "ok": True,
        "app_env": s.app_env,
        "auth_disabled": s.auth_disabled,
        "oidc_configured": configured,
        "oidc_issuer": s.oidc_issuer or None,
        "oidc_audience": s.oidc_audience or None,
        "jwks": "static" if s.oidc_jwks_static_json else ("url" if s.oidc_jwks_url else None),
        "ready_for_production_auth": configured
        and not s.auth_disabled
        and s.app_env in ("staging", "production"),
    }


class E2ECampaignBody(BaseModel):
    phone: str = Field(min_length=8, max_length=20)
    first_name: str = Field(default="Prueba", max_length=80)
    flow: str = Field(default="A", pattern="^[AB]$")
    skip_voice: bool = False
    skip_whatsapp: bool = False
    flow_id: str | None = None
    agency_tag: str | None = None
    idempotency_key: str | None = Field(default=None, max_length=120)


async def _e2e_campaign(
    body: E2ECampaignBody,
    ctx: AuthContext,
) -> dict[str, Any]:
    """AUD-021: demo path with durable saga checkpoints (voice→WA→doc→handoff→CRM)."""
    from pilot_core.modules.product_flow import resolve_product_flow

    settings = get_settings()
    product = resolve_product_flow(body.flow)
    idem = (body.idempotency_key or "").strip() or f"e2e:{body.flow}:{body.phone}"
    claimed, saga = ops_store.claim_saga(
        "e2e",
        idem,
        {"steps": {}, "phone": body.phone, "flow": body.flow},
    )
    if not claimed and saga and saga.get("status") == "completed":
        done = saga.get("result")
        result: dict[str, Any] = done if isinstance(done, dict) else {}
        return {**result, "idempotent": True, "saga_id": saga.get("id")}
    if not claimed and saga and saga.get("status") == "processing":
        raise PlatformError(
            "saga_in_flight",
            "E2E campaign already being processed",
            status_code=409,
            details={"saga_id": saga.get("id")},
        )
    assert saga is not None
    steps: dict[str, Any] = dict(saga.get("steps") or {})

    try:
        channels: list[str] = []
        if not body.skip_voice:
            channels.append("voz")
        if not body.skip_whatsapp:
            channels.append("whatsapp")
        if not channels:
            channels.append("whatsapp")

        if "compliance" not in steps:
            blocked: list[str] = []
            compliance_steps: dict[str, Any] = {}
            for ch in channels:
                decision = compliance_service.evaluate(phone=body.phone, channel=ch)
                compliance_steps[ch] = compliance_service.as_dict(decision)
                if not decision.allowed:
                    blocked.extend(decision.reasons)
            blocked_unique: list[str] = []
            seen_r: set[str] = set()
            for r in blocked:
                if r not in seen_r:
                    seen_r.add(r)
                    blocked_unique.append(r)
            steps["compliance"] = compliance_steps
            saga["steps"] = steps
            ops_store.save_saga(saga)
            if blocked_unique:
                raise PlatformError("compliance_blocked", ",".join(blocked_unique), status_code=403)

        if "voice" not in steps:
            if not body.skip_voice:
                steps["voice"] = await orchestration_service.attempt_call(
                    phone=body.phone,
                    first_name=body.first_name,
                    flow=product["flow"],
                    tenant_id=ctx.tenant_id,
                )
            else:
                steps["voice"] = {"skipped": True}
            saga["steps"] = steps
            ops_store.save_saga(saga)

        override_id = (body.flow_id or "").strip() or None
        default_a = (settings.liwa_default_flow_id or "").strip()
        if body.flow == "B" and override_id and override_id == default_a:
            override_id = None
        wa_flow_id = override_id or product["liwa_flow_id"]

        if "whatsapp" not in steps:
            if not body.skip_whatsapp:
                if settings.liwa_live_enabled():
                    steps["whatsapp"] = await liwa_whatsapp_service.send(
                        phone=body.phone,
                        first_name=body.first_name,
                        kind="flow",
                        flow_id=wa_flow_id,
                        text=f"E2E {product['segment']} PULSO",
                    )
                else:
                    steps["whatsapp"] = whatsapp_mock_service.send_text(
                        phone=body.phone, text=f"E2E {product['segment']} mock"
                    )
            else:
                steps["whatsapp"] = {"skipped": True}
            saga["steps"] = steps
            ops_store.save_saga(saga)

        if "document" not in steps:
            pdf_bytes = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
            steps["document"] = documents_service.register(
                filename=f"orden_matricula_e2e_{product['flow'].lower()}.pdf",
                content_type="application/pdf",
                size_bytes=len(pdf_bytes),
                contact_phone=body.phone,
                kind=str(product["document_kind"]),
                content=pdf_bytes,
            )
            saga["steps"] = steps
            ops_store.save_saga(saga)

        if "handoff" not in steps:
            handoff_body = CreateHandoffBody(
                name=body.first_name,
                segment=str(product["segment"]),
                motivo=f"E2E {product['name']} — doc validado",
                priority="alta",
                phone=body.phone,
                agency_tag=body.agency_tag or str(product["liwa_handoff_tag"]),
                idempotency_key=f"handoff-e2e:{idem}",
            )
            steps["handoff"] = await create_handoff(handoff_body, ctx)
            saga["steps"] = steps
            ops_store.save_saga(saga)

        if "crm" not in steps:
            try:
                prior_crm = steps.get("crm") if isinstance(steps.get("crm"), dict) else None
                if prior_crm and prior_crm.get("id"):
                    steps["crm"] = {**prior_crm, "resumed": True}
                else:
                    lead = crm_service.create_lead(
                        name=body.first_name,
                        funnel=str(product["crm_funnel"]),
                        phone=body.phone,
                    )
                    lead_id = str(lead.get("id") or "")
                    if lead_id:
                        steps["crm"] = crm_service.move(
                            lead_id=lead_id, to_column="contactado", tipificacion=None
                        )
                    else:
                        steps["crm"] = lead
            except Exception:  # noqa: BLE001
                steps["crm"] = {"ok": False, "error": "crm_update_failed"}
            saga["steps"] = steps
            ops_store.save_saga(saga)

        ok = True
        wa = steps.get("whatsapp") or {}
        if not body.skip_whatsapp and wa.get("skipped") is not True and wa.get("ok") is False:
            ok = False
        voice = steps.get("voice") or {}
        if not body.skip_voice and voice.get("skipped") is not True and voice.get("ok") is False:
            ok = False
        doc = steps.get("document") or {}
        if isinstance(doc, dict):
            doc_status = str(doc.get("status") or "")
            if doc.get("ok") is False or (doc_status and doc_status != "validated"):
                ok = False
        ho = steps.get("handoff") or {}
        liwa = ho.get("liwa") if isinstance(ho, dict) else None
        if isinstance(liwa, dict) and liwa.get("ok") is False:
            ok = False
        crm = steps.get("crm") or {}
        if isinstance(crm, dict) and crm.get("ok") is False:
            ok = False

        result = {
            "ok": ok,
            "phone": body.phone if not should_mask_pii(ctx) else mask_phone(body.phone),
            "flow": product["flow"],
            "product": {
                "name": product["name"],
                "segment": product["segment"],
                "liwa_flow_id": wa_flow_id or product["liwa_flow_id"],
                "liwa_handoff_tag": product["liwa_handoff_tag"],
                "liwa_flow_fallback_to_a": product["liwa_flow_fallback_to_a"],
            },
            "steps": steps,
            "saga_id": saga.get("id"),
        }
        saga["status"] = "completed" if ok else "failed"
        saga["result"] = result
        saga["steps"] = steps
        ops_store.save_saga(saga)
        return result
    except PlatformError:
        saga["status"] = "failed"
        saga["steps"] = steps
        ops_store.save_saga(saga)
        raise
    except Exception as exc:  # noqa: BLE001
        saga["status"] = "failed"
        saga["error"] = str(exc)[:200]
        saga["steps"] = steps
        ops_store.save_saga(saga)
        raise


@router.post("/e2e/renovacion")
async def e2e_renovacion(
    body: E2ECampaignBody,
    ctx: AuthContext = Depends(require_ops_roles(*OPS_MANAGE)),
) -> dict[str, Any]:
    payload = body.model_copy(update={"flow": "A"})
    return await _e2e_campaign(payload, ctx)


@router.post("/e2e/reactivacion")
async def e2e_reactivacion(
    body: E2ECampaignBody,
    ctx: AuthContext = Depends(require_ops_roles(*OPS_MANAGE)),
) -> dict[str, Any]:
    payload = body.model_copy(update={"flow": "B"})
    return await _e2e_campaign(payload, ctx)


@router.post("/e2e/campaign")
async def e2e_campaign(
    body: E2ECampaignBody,
    ctx: AuthContext = Depends(require_ops_roles(*OPS_MANAGE)),
) -> dict[str, Any]:
    return await _e2e_campaign(body, ctx)


class BatchAttemptBody(BaseModel):
    campaign_id: str | None = None
    flow: str = Field(default="A", pattern="^[AB]$")
    limit: int = Field(default=20, ge=1, le=200)


@router.post("/orchestration/batch")
async def orchestration_batch(
    body: BatchAttemptBody, ctx: AuthContext = Depends(require_ops_roles(*OPS_MANAGE))
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
        row = {"phone": c["phone"], **r}
        if should_mask_pii(ctx):
            row = mask_phone_fields(row)
        results.append(row)
    ok = sum(1 for x in results if x.get("ok"))
    blocked = sum(1 for x in results if x.get("blocked"))
    return {
        "ok": True,
        "total": len(results),
        "sent_or_queued": ok,
        "blocked": blocked,
        "results": results,
        "pii_masked": should_mask_pii(ctx),
    }

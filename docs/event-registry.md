# Registro de productores y consumidores de eventos

Schema version actual del envelope: ver `contracts/events/v1/_envelope.json` (se actualizará en Fase 4 con `tenant_id`, `business_idempotency_key`, `data_classification`).

| event_type | Productor canónico | Consumidores | Notas |
|---|---|---|---|
| `contact.imported` | pilot-core / contacts | segmentation, compliance | No Dialer |
| `contact.scored` | pilot-core / segmentation | campaigns, crm | Incluye `score_version` |
| `contact.eligibility.decided` | pilot-core / compliance | orchestration, campaigns | Gate obligatorio |
| `campaign.created` | pilot-core / campaigns | analytics | |
| `campaign.enrolled` | pilot-core / campaigns | analytics | |
| `contact.attempt.requested` | pilot-core / orchestration | analytics | Antes de proveedor |
| `contact.attempted` | pilot-core / orchestration | crm, analytics | |
| `call.requested` | pilot-core / orchestration | (interno) | Mapea a Dialer |
| `call.dispatched` | pilot-core / orchestration | analytics | |
| `call.completed` | pilot-core / orchestration | crm, analytics | Desde webhook Dialer |
| `call.disposition.recorded` | pilot-core / crm | analytics | Separado de AMD técnico |
| `wa.send.requested` | pilot-core | whatsapp-adapter | |
| `wa.message.received` | whatsapp-adapter | pilot-core / crm | |
| `wa.message.sent` | whatsapp-adapter | pilot-core, analytics | |
| `wa.message.delivered` | whatsapp-adapter | analytics | |
| `wa.message.read` | whatsapp-adapter | analytics | |
| `wa.message.failed` | whatsapp-adapter | pilot-core, analytics | |
| `document.received` | documents | pilot-core / crm | Sin binario |
| `document.validated` | documents | pilot-core / crm | |
| `document.rejected` | documents | pilot-core / crm | |
| `lead.qualified` | pilot-core / crm | handoff-liwa, analytics | |
| `handoff.created` | handoff-liwa | pilot-core, analytics | |
| `handoff.assigned` | handoff-liwa | analytics | |
| `handoff.resolved` | handoff-liwa | pilot-core / crm | |
| `preference.changed` | whatsapp-adapter / pilot-core | compliance | Opt-out / canal |
| `contact.suppressed` | pilot-core / compliance | orchestration, campaigns, whatsapp-adapter | Cancela pendientes |
| `core.outcome.recorded` | pilot-core / core-adapter | crm, analytics | Core = verdad financiera |

## Eventos legacy (scaffold)

Los schemas en `contracts/events/v1/call.requested.json` etc. se migrarán en Fase 4. Hasta entonces, no publicar payloads incompletos en producción.

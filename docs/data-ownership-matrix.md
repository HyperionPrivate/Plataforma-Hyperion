# Matriz de ownership — datos, comandos, eventos, retención

> Estratégia: modular primero ([ADR-005](ADR-005-modular-first.md)).  
> Owners de personas: ver [OWNERSHIP_REQUEST.md](OWNERSHIP_REQUEST.md).

## Unidades desplegables

| Unidad | DB | Comandos (write) | Eventos que publica | Eventos que consume | Retención (borrador; validar jurídico) |
|---|---|---|---|---|---|
| `pilot-core` | `db_pilot_core` | contactos, campañas, CRM, compliance decisions, scores, voice attempts, agent versions, analytics projections | `contact.*`, `campaign.*`, `call.*`, `contact.attempt.*`, `lead.qualified`, `preference.*`, `contact.suppressed`, `core.outcome.recorded` | `wa.*`, `document.*`, `handoff.*` | Operativo 2 años; audit PII según política tenant; analytics sin PII |
| `whatsapp-adapter` | `db_whatsapp` | mensajes, templates, webhooks WA | `wa.send.requested` (ack interno), `wa.message.*`, `preference.changed` / opt-out | `wa.send.requested` (desde core), `contact.suppressed` | Mensajes según política canal; media por referencia |
| `documents` | `db_documents` | metadatos, validación; binarios en object store | `document.received`, `document.validated`, `document.rejected` | referencias desde CRM/WA | Retención configurable; delete auditado |
| `handoff-liwa` | `db_handoff` | casos, asignación, SLA | `handoff.created`, `handoff.assigned`, `handoff.resolved` | `lead.qualified` | Expedientes según SLA + retención legal |

## Externos

| Sistema | Verdad | Este monorepo |
|---|---|---|
| Dialer / ElevenLabs | Telefonía técnica | Solo orchestration en `pilot-core` |
| Core Coopfuturo | Resultado financiero | Adapter + `core.outcome.recorded` |
| OIDC IdP | Identidad | Validación JWT en edge / app |

## Reglas

- Un solo escritor canónico por agregado.
- Analytics **no** recibe texto crudo, docs, audio ni PII; solo referencias opacas y métricas.
- Políticas horarias / RNE / habeas data son **configurables** y requieren validación jurídica.

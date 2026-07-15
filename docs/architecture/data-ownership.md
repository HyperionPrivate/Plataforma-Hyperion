# Ownership de datos

> **Alcance:** fundación arquitectónica. **No hay features comerciales de producto implementadas todavía.**

Este documento consolida la matriz de ownership. Versión extendida histórica: [data-ownership-matrix.md](../data-ownership-matrix.md).

## Principios

1. **Un escritor canónico** por agregado de dominio.
2. **Una base de datos por unidad** desplegable — sin acceso cross-DB ([ADR-004](../adr/ADR-004-database-ownership.md)).
3. Sincronización entre unidades vía **eventos** o APIs con contrato versionado.
4. **Analytics** recibe solo referencias opacas y métricas; nunca PII ([ADR-011](../adr/ADR-011-pii-handling.md)).

## Matriz por unidad

| Unidad | Database | Comandos (write) | Eventos publicados | Eventos consumidos |
|---|---|---|---|---|
| `pilot-core` | `db_pilot_core` | contactos, campañas, CRM, compliance, scores, voice attempts, agent versions, proyecciones | `contact.*`, `campaign.*`, `call.*`, `contact.attempt.*`, `lead.qualified`, `preference.*`, `contact.suppressed`, `core.outcome.recorded` | `wa.*`, `document.*`, `handoff.*` |
| `whatsapp-adapter` | `db_whatsapp` | mensajes, templates, webhooks WA | `wa.message.*`, `preference.changed` | `wa.send.requested`, `contact.suppressed` |
| `documents` | `db_documents` | metadatos, validación; binarios en object store | `document.received`, `document.validated`, `document.rejected` | referencias desde CRM/WA |
| `handoff-liwa` | `db_handoff` | casos, asignación, SLA | `handoff.created`, `handoff.assigned`, `handoff.resolved` | `lead.qualified` |

## Sistemas externos (verdad fuera del monorepo)

| Sistema | Verdad de | Cliente en monorepo |
|---|---|---|
| Dialer / ElevenLabs | Telefonía técnica | `pilot-core.orchestration` |
| Core Coopfuturo | Outcome financiero | `pilot-core.core_adapter` |
| OIDC IdP | Identidad usuario | Edge / apps |
| LIWA | Canal WhatsApp comercial | `whatsapp-adapter`, `handoff-liwa` |

## Retención (borrador — validar jurídico)

| Tipo de dato | Retención propuesta | Owner |
|---|---|---|
| Datos operativos pilot-core | 2 años | `@TBD-pilot-core` |
| Mensajes WhatsApp | Política canal | `@TBD-whatsapp` |
| Documentos | Configurable por tenant | `@TBD-documents` |
| Expedientes handoff | SLA + retención legal | `@TBD-handoff` |
| Audit PII | Según política tenant | `@TBD-security` |

## Registro de eventos

Detalle productor/consumidor: [event-registry.md](../event-registry.md).

## Ownership de personas

Placeholders TBD — [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).

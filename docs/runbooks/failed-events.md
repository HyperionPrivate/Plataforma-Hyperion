# Runbook — Eventos fallidos y dead-letter

> **Alcance:** fundación arquitectónica. Messaging Fase 4 — procedimiento target.

## Síntomas

- Consumer lag creciente en Redis Streams
- Eventos en dead-letter stream / tabla `inbox_failed`
- Errores repetidos en logs: `event_handler_failed`

## Diagnóstico

```powershell
# Lag de consumer group (ejemplo)
docker compose exec redis redis-cli XINFO GROUPS coopfuturo.events

# Pending messages
docker compose exec redis redis-cli XPENDING coopfuturo.events pilot-core-workers
```

Revisar logs del consumidor con `correlation_id` / `event_id`.

## Clasificación de fallos

| Tipo | Acción |
|---|---|
| Transiente (timeout, 503) | Reintento automático con backoff |
| Schema inválido | Fix productor; no replay ciego |
| Bug en handler | Fix código; replay controlado |
| Duplicado (idempotencia) | Ignorar — inbox ya registró `event_id` |
| Poison message | Mover a DLQ; alertar owner |

## Dead-letter queue (DLQ)

- Stream dedicado: `coopfuturo.events.dlq`
- Campos: `original_event_id`, `error`, `failed_at`, `consumer`, `payload`

## Replay manual

1. Confirmar fix desplegado
2. Verificar idempotencia (inbox) — replay no debe duplicar efectos
3. Republicar desde DLQ a stream principal con nuevo `event_id` o mismo según política
4. Auditar en ticket/incident

```powershell
# Ejemplo conceptual — herramienta CLI TBD
# coopfuturo-events replay --from-dlq --event-id <uuid> --dry-run
```

## Escalación

| Área | Owner |
|---|---|
| Eventos dominio pilot-core | `@TBD-pilot-core` |
| WhatsApp events | `@TBD-whatsapp` |
| Infra Redis | `@TBD-platform` |
| Contratos schema | `@TBD-contracts` |

Ver [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).

## Prevención

- Outbox/inbox ([ADR-006](../adr/ADR-006-outbox-inbox-idempotency.md))
- Validación schema en consumidor
- Alertas consumer lag ([ADR-010](../adr/ADR-010-observability.md))

## Referencias

- [event-flow.md](../architecture/event-flow.md)
- [event-registry.md](../event-registry.md)

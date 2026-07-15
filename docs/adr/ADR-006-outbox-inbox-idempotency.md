# ADR-006 — Outbox, inbox e idempotencia

## Estado

Accepted — 2026-07-15

## Contexto

Publicar eventos y persistir estado en la misma transacción evita inconsistencias (dual-write). Consumidores at-least-once requieren deduplicación.

**Alcance actual:** patrón documentado; tablas outbox/inbox pendientes de implementación en fases de messaging.

## Decisión

1. **Transactional Outbox** por unidad desplegable:
   - Eventos se insertan en tabla `outbox` en la misma transacción que el cambio de dominio.
   - Un relay process publica desde outbox a Redis Streams y marca como publicado.

2. **Inbox** en consumidores:
   - Tabla `inbox` registra `event_id` (o `business_idempotency_key`) procesados.
   - Reintentos no reprocesan eventos ya aplicados.

3. **Claves de idempotencia:**
   - `event_id`: UUID único por evento emitido.
   - `business_idempotency_key`: clave de negocio estable (p.ej. `contact_id + attempt_no`).
   - Ambos campos en el envelope v1 (Fase 4).

4. Handlers deben ser **idempotentes**: mismo input → mismo estado final, sin efectos duplicados.

5. Eventos fallidos van a dead-letter stream/tabla; ver [runbooks/failed-events.md](../runbooks/failed-events.md).

## Consecuencias

- Latencia adicional mínima por relay outbox; consistencia fuerte entre DB y bus.
- Schema adicional por unidad (outbox + inbox).
- Operaciones de replay requieren procedimiento documentado y auditoría.

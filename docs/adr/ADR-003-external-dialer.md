# ADR-003 — Dialer externo al monorepo

## Estado

Accepted — 2026-07-15

## Contexto

Existe un stack de voz maduro (Dialer + ASR + AMD) en repositorio separado. Coopfuturo necesita orquestar llamadas salientes sin duplicar ni forkar ese código.

**Alcance actual:** cliente HTTP stub/mock en `orchestration`; sin integración productiva con Dialer real.

## Decisión

1. El Dialer **permanece fuera** de este monorepo — no se copia, no se forkea como dependencia de código.

2. **Único caller HTTP permitido:** módulo `orchestration` dentro de `apps/pilot-core`.
   - Ningún otro módulo, unidad desplegable ni stub legacy puede invocar al Dialer directamente.

3. ASR y AMD son companions del Dialer; no son servicios de este monorepo.

4. Configuración exclusiva en orchestration:
   - `DIALER_BASE_URL`
   - `DIALER_API_TOKEN`

5. Webhooks/resultados del Dialer se mapean a eventos internos (`call.completed`, `call.dispatched`, etc.) según [event-registry.md](../event-registry.md).

## Consecuencias

- Equipos de voz y de negocio evolucionan en repos distintos con contrato OpenAPI versionado.
- Orchestration concentra resiliencia (retries, circuit breaker) hacia el Dialer.
- Bloqueo externo: contrato OpenAPI productivo pendiente ([EXTERNAL_BLOCKERS.md](../EXTERNAL_BLOCKERS.md)).

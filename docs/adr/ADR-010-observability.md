# ADR-010 — Observabilidad

## Estado

Accepted — 2026-07-15

## Contexto

Operar cuatro unidades desplegables, un bus de eventos e integraciones externas requiere visibilidad unificada de salud, latencia y errores.

**Alcance actual:** endpoints `/health` por unidad; sin stack APM/tracing productivo.

## Decisión

1. **Tres pilares:** logs estructurados (JSON), métricas (Prometheus-compatible) y trazas distribuidas (OpenTelemetry).

2. **Correlación:** `trace_id` y `correlation_id` propagados en HTTP headers y envelope de eventos.

3. **Logs:**
   - Nivel INFO en producción; DEBUG solo en dev.
   - Sin PII en logs (ver [ADR-011](ADR-011-pii-handling.md)).
   - Campos estándar: `service`, `tenant_id`, `event_type`, `duration_ms`, `status`.

4. **Métricas mínimas por unidad:**
   - Request rate, error rate, latency p50/p95/p99.
   - Outbox lag, consumer lag (Redis Streams).
   - Health check success.

5. **Alertas:** definidas por `@TBD-platform` en fase de hardening; SLOs iniciales TBD.

6. Dashboard Traefik deshabilitado en local por defecto (seguridad).

## Consecuencias

- Overhead de instrumentación en cada unidad; mitigado con middleware compartido.
- Coste de almacenamiento de telemetría; retención configurable.
- Sin observabilidad completa, operación en producción no está autorizada.

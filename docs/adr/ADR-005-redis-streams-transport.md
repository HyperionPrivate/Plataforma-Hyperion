# ADR-005 — Redis Streams como transporte inicial

## Estado

Accepted — 2026-07-15

## Contexto

Las unidades desplegables deben comunicarse de forma asíncrona con garantías at-least-once sin acoplar bases de datos. Se necesita un bus ligero para desarrollo local y piloto inicial.

**Alcance actual:** Redis provisionado en Compose; publicación/consumo de eventos en fases posteriores. Sin tráfico productivo.

## Decisión

1. **Transporte inicial:** Redis Streams como message bus entre unidades.

2. **Abstracción reemplazable:** la capa de messaging expone una interfaz (`EventPublisher`, `EventConsumer`) independiente del backend. Redis Streams es la implementación default; Kafka/NATS/SQS son candidatos futuros sin cambiar contratos de eventos.

3. Convenciones:
   - Stream por dominio o por tipo de evento según volumen (detalle en runbook [failed-events.md](../runbooks/failed-events.md)).
   - Consumer groups por unidad consumidora.
   - Envelope versionado en `contracts/events/v1/`.

4. Redis también puede usarse para cache efímero; streams de eventos y cache usan namespaces/DB index separados.

## Consecuencias

- Simplicidad operativa en local y piloto; un solo componente infra adicional.
- Límites de retención y ordering de Redis Streams deben monitorearse antes de escala masiva.
- Migración a broker enterprise requiere dual-write o cutover planificado; la abstracción reduce el coste.

# ADR-011 — Manejo de PII

## Estado

Accepted — 2026-07-15

## Contexto

Coopfuturo procesará datos personales (teléfonos, nombres, documentos). Regulación colombiana (habeas data, RNE) y políticas internas exigen minimización y trazabilidad.

**Alcance actual:** políticas documentadas; sin flujos productivos con PII real.

## Decisión

1. **Clasificación de datos** en envelope de eventos: `public`, `internal`, `confidential`, `restricted_pii` (campo `data_classification` en envelope v1).

2. **Minimización:**
   - Eventos cross-unidad transportan IDs opacos y metadatos necesarios; no texto libre de conversaciones ni binarios.
   - Módulo `analytics` **nunca** recibe PII, audio, documentos ni transcripciones crudas.

3. **Retención:** por unidad según [data-ownership.md](../architecture/data-ownership.md); validación jurídica pendiente ([EXTERNAL_BLOCKERS.md](../EXTERNAL_BLOCKERS.md)).

4. **Opt-out / supresión:** evento `contact.suppressed` cancela intentos pendientes en orchestration, campaigns y whatsapp-adapter.

5. **Acceso:** PII solo en la unidad owner del agregado; acceso cross-unit vía API autorizada con audit log.

6. **Cifrado:** TLS en tránsito; cifrado at-rest en Postgres/object storage en producción (config infra TBD).

7. **Derechos del titular:** procedimiento de eliminación/anonymization TBD con área legal.

## Consecuencias

- Schemas de eventos más estrictos; rechazo de payloads con PII no autorizada.
- Analytics limitado a métricas agregadas hasta warehouse controlado.
- Compliance module es gate obligatorio pre-contacto (ver [ADR-002](ADR-002-bounded-contexts.md)).

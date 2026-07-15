# ADR-001 — Arquitectura modular primero

## Estado

Accepted — 2026-07-15

## Contexto

Coopfuturo PULSO requiere contactación multicanal (voz, WhatsApp, documentos, handoff humano) con equipos que puedan evolucionar en paralelo. Un despliegue inicial de diez microservicios stub incrementa coste operativo sin dominio productivo implementado.

**Alcance actual:** fundación arquitectónica únicamente. **No hay features comerciales de producto implementadas todavía** — solo scaffold, contratos, mocks y health checks.

## Decisión

1. Adoptar estrategia **modular first**: cuatro unidades desplegables iniciales en `apps/`:
   - `pilot-core` — dominio central (contactos, campañas, CRM, compliance, segmentación, orquestación, agent-config, analytics).
   - `whatsapp-adapter` — canal WhatsApp / LIWA.
   - `documents` — metadatos y object storage.
   - `handoff-liwa` — expedientes y handoff a asesores.

2. Los stubs legacy en `services/*` se conservan hasta reemplazo verificado con tests; no usar para features nuevas.

3. Extracción a microservicio independiente solo cuando cumpla criterios documentados en [ADR-013](ADR-013-extraction-criteria.md).

4. Owners de código: placeholders TBD hasta confirmación en [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).

## Consecuencias

- Menor superficie operativa al día 1; fronteras de datos y eventos siguen siendo explícitas por contexto.
- Riesgo de acoplamiento dentro de `pilot-core`: mitigado con bounded contexts (ver [ADR-002](ADR-002-bounded-contexts.md)) y tests de frontera.
- Documentación y contratos preceden a implementación de lógica de negocio comercial.

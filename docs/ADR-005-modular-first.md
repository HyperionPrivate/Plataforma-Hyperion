# ADR-005 — Modular primero, extracción por evidencia

> **Supersedido por:** [adr/ADR-001-modular-architecture.md](adr/ADR-001-modular-architecture.md) y [adr/ADR-013-extraction-criteria.md](adr/ADR-013-extraction-criteria.md).

## Estado
Aceptado — 2026-07-15

## Contexto

El scaffold inicial desplegaba diez microservicios stub. Desplegar diez unidades sin dominio real multiplica coste operativo sin beneficio. El piloto PULSO necesita velocidad de entrega con límites de bounded context claros.

## Decisión

1. **Unidades desplegables iniciales (4):**
   - `apps/pilot-core` — contactos, campañas, CRM/funnels, compliance, segmentación, orquestación, agent-config, proyecciones analíticas iniciales.
   - `apps/whatsapp-adapter` — LIWA/WABA, webhooks, mensajes, plantillas, opt-out.
   - `apps/documents` — metadatos, object storage, validación, retención.
   - `apps/handoff-liwa` — expedientes, asignación, SLA, retorno a CRM.

2. Dentro de `pilot-core`, los bounded contexts viven como **módulos Python** (`pilot_core.contacts`, `.campaigns`, `.crm`, …) con límites de import documentados.

3. **Extracción a microservicio** solo cuando haya evidencia: equipo independiente, escala distinta, ciclo de release distinto, o aislamiento de fallo requerido.

4. Los stubs en `services/*` **se conservan** hasta que el reemplazo exista, pase tests y smoke. No se borran al introducir `apps/`.

5. Externos: Dialer/ElevenLabs (solo desde orchestration en pilot-core), Core financiero Coopfuturo (fuente maestra de outcome financiero), OIDC en el edge.

## Consecuencias

- Menos contenedores al día 1; contratos y ownership de datos siguen siendo por contexto.
- Riesgo de “modular monolith” mal acotado: mitigado con matriz de ownership y tests de frontera.
- CODEOWNERS apunta a unidades `apps/*`; stubs legacy a platform.

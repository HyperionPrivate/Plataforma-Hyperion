# ADR-013 — Criterios de extracción a microservicio

## Estado

Accepted — 2026-07-15

## Contexto

La estrategia modular first concentra dominio en `pilot-core`. Extraer demasiado pronto aumenta coste; extraer demasiado tarde genera monolito acoplado.

**Alcance actual:** cuatro unidades desplegables; módulos internos sin extracción planificada.

## Decisión

Extraer un módulo de `pilot-core` a microservicio independiente (`apps/<nuevo>`) **solo** cuando se cumplan **≥2** criterios:

| # | Criterio | Evidencia requerida |
|---|---|---|
| 1 | **Equipo independiente** | Squad dedicado con capacity ≥0.5 FTE sostenido |
| 2 | **Escala distinta** | Métricas de CPU/RPS/latencia desproporcionadas vs resto de pilot-core |
| 3 | **Ciclo de release distinto** | Necesidad de deploy diario vs semanal del core |
| 4 | **Aislamiento de fallo** | Incidentes recurrentes que afectan unidades no relacionadas |
| 5 | **Requisito regulatorio** | Aislamiento de datos/compute exigido por compliance |
| 6 | **Integración externa pesada** | SDK o SLA de tercero que justifica boundary propio |

**Proceso de extracción:**

1. ADR nuevo documentando decisión y plan de migración.
2. DB propia (ver [ADR-004](ADR-004-database-ownership.md)).
3. Contratos HTTP/eventos publicados antes del cutover.
4. Dual-run period con tests de paridad.
5. Actualizar [service-catalog.md](../architecture/service-catalog.md) y CODEOWNERS.

**Anti-patrón:** extraer por moda tecnológica sin evidencia.

## Consecuencias

- pilot-core permanece unidad principal durante el piloto PULSO.
- Extracciones son eventos raros y deliberados.
- Stubs en `services/` se retiran solo tras reemplazo verificado en `apps/`.

# ADR-002 — Bounded contexts dentro de pilot-core

## Estado

Accepted — 2026-07-15

## Contexto

`pilot-core` concentra múltiples capacidades de dominio. Sin límites explícitos, un módulo monolítico acopla deploys, ownership y evolución independiente de equipos.

**Alcance actual:** módulos Python con stubs de servicio; sin lógica comercial productiva.

## Decisión

1. Cada bounded context vive como paquete bajo `pilot_core.modules.<context>`:

   | Módulo | Responsabilidad |
   |---|---|
   | `contacts` | Ingesta, normalización, deduplicación |
   | `campaigns` | Campañas, enrollments, attempts |
   | `crm` | Funnels, tipificaciones, `lead.qualified` |
   | `compliance` | Gate obligatorio pre-contacto |
   | `segmentation` | Scores versionados |
   | `orchestration` | Sagas y cliente Dialer (único caller HTTP) |
   | `agent_config` | Versionado de agentes |
   | `analytics` | Proyecciones sin PII |
   | `core_adapter` | Outcome financiero (mock/real) |

2. **Reglas de import:**
   - Un módulo **no** importa repositorios ni modelos ORM de otro módulo.
   - Comunicación inter-módulo: interfaces internas, eventos de dominio o application services expuestos explícitamente.
   - `orchestration` es el único módulo autorizado a llamar al Dialer externo.

3. Cada módulo tiene un owner TBD (ver [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md)); `@TBD-pilot-core` es owner transversal hasta desglose.

4. Tests de frontera verifican que imports prohibidos no existen (lint/architecture tests en fases posteriores).

## Consecuencias

- Refactors internos no requieren redeploy de otras unidades desplegables.
- Extracción futura de un módulo a microservicio tiene frontera ya definida.
- Overhead inicial de disciplina de imports; compensado por menor deuda de acoplamiento.

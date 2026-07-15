# ADR-015 — Deploy y rollback

## Estado

Accepted — 2026-07-15

## Contexto

Cuatro unidades desplegables con dependencias en Postgres, Redis e integraciones externas requieren procedimiento predecible de release y recuperación ante fallos.

**Alcance actual:** Docker Compose local; sin pipeline CD productivo. Solo fundación arquitectónica.

## Decisión

1. **Unidad de deploy:** cada app en `apps/` se despliega independientemente cuando sus tests y contratos pasan CI.

2. **Orden recomendado en release multi-unidad:**
   1. Migraciones DB (expand).
   2. Consumidores compatibles con schema/event version anterior.
   3. Productores con nuevo schema/event.
   4. Contract migrations (drop columnas obsoletas).

3. **Estrategia de rollout:** rolling update por unidad; blue/green o canary en producción (TBD infra).

4. **Rollback:**
   - **Código:** redeploy imagen anterior (tag inmutable en registry).
   - **Schema:** migración compensatoria forward; no revertir migraciones ya aplicadas en prod con datos.
   - **Eventos:** consumidores deben tolerar eventos de versión anterior durante ventana de dual-publish.

5. **Health gates:** `/ready` debe pasar antes de recibir tráfico; orchestration verifica conectividad Dialer mock/real según entorno.

6. **Feature flags:** lógica comercial futura detrás de flags; actualmente no hay features comerciales activas.

7. Runbook: [runbooks/startup.md](../runbooks/startup.md).

## Consecuencias

- Deploys independientes aceleran equipos pero exigen compatibilidad de contratos.
- Rollback de código es rápido; rollback de schema requiere planificación.
- Imágenes Docker taggeadas por commit SHA; no `:latest` en producción.

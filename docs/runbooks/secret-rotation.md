# Runbook — Rotación de secretos

> **Alcance:** fundación arquitectónica. Secret manager productivo TBD.

## Principios

- **Nunca** commitear secretos reales ([ADR-009](../adr/ADR-009-secrets-strategy.md))
- Rotación sin downtime: dual-active window cuando el proveedor lo permita
- Auditar cada rotación

## Credencial LIWA histórica (CRÍTICO)

| Paso | Acción | Responsable |
|---|---|---|
| 1 | Invalidar token expuesto en documentación externa | Operaciones LIWA / `@TBD-security` |
| 2 | Emitir token nuevo en secret manager (no en repo) | `@TBD-platform` |
| 3 | Actualizar `whatsapp-adapter` y `handoff-liwa` en runtime | `@TBD-whatsapp`, `@TBD-handoff` |
| 4 | Cambiar `LIWA_MODE=real` solo tras prueba en staging | `@TBD-whatsapp` |
| 5 | Verificar [EXTERNAL_BLOCKERS.md](../EXTERNAL_BLOCKERS.md) cerrado | `@TBD-platform` |

**Hasta completar paso 1–2:** mantener `LIWA_MODE=mock`.

## Dialer API token

- Secret exclusivo de `pilot-core.orchestration`
- Rotar en Dialer admin → actualizar secret manager → rolling restart pilot-core
- Variables: `DIALER_API_TOKEN`, `DIALER_BASE_URL`

## Service-to-service tokens

- Emitidos por IdP (client credentials) — pendiente IdP
- Rotación: nuevo client secret → deploy todas las unidades consumidoras → revocar anterior

## Base de datos

- Passwords `app_*` por unidad
- Rotación: `ALTER ROLE ... PASSWORD` → actualizar secret manager → rolling restart unidad afectada

## Redis

- Rotar password ACL → actualizar `REDIS_URL` en todas las unidades → restart

## Desarrollo local

- Usar placeholders en `.env` gitignored
- No copiar tokens de producción a máquinas de desarrollo

## Checklist post-rotación

- [ ] Health checks verdes en todas las unidades
- [ ] Smoke test integración (mock o real según entorno)
- [ ] Token anterior revocado en proveedor
- [ ] Entrada en log de cambios / incident si aplica
- [ ] EXTERNAL_BLOCKERS actualizado

## Escalación

`@TBD-security` — [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).

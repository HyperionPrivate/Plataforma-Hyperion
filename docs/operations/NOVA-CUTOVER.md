---
documentType: runbook
status: not-current
owner: nova-operations
issue: HYP-NOVA-010
reviewDue: 2026-09-30
---

# Corte real NOVA (fase 6)

> **No vigente para producción.** Falta revalidarlo contra `nova-console`, el BFF propio, el contexto Docker
> cerrado y un manifiesto de release NOVA fijado por digest.

El texto histórico asumía un cambio mock/live que el runtime actual no implementa como barrera suficiente. La
activación real depende de credenciales completas y validación del adaptador, por lo que ningún valor de esta tabla
autoriza por sí solo un cutover.

## Flags

| Variable                     | Valor versionado/transicional  | Condición para una futura revalidación                  |
| ---------------------------- | ------------------------------ | ------------------------------------------------------- |
| `VOICE_MODE`                 | `dialer`                       | No tratarlo como feature flag ni fallback mock.         |
| `DIALER_BASE_URL`            | red interna del Neutral Dialer | Origen aprobado, fijado y protegido contra SSRF.        |
| `DIALER_ADMIN_USER`          | vacío fuera del overlay        | Credencial externa rotada.                              |
| `DIALER_ADMIN_PASSWORD`      | vacío fuera del overlay        | Secreto externo; nunca documentarlo ni registrarlo.     |
| `DIALER_DEMO_API_KEY`        | vacío fuera del overlay        | API key dedicada y rotada.                              |
| `DIALER_WEBHOOK_HMAC_SECRET` | placeholder en `.env.example`  | HMAC dedicado y rotado.                                 |
| `LIWA_MODE`                  | `http`                         | Etiqueta transicional; no demuestra conexión saludable. |
| `LIWA_BASE_URL`              | `https://chat.liwa.co/api`     | Host allowlisted y contrato del proveedor verificado.   |
| `LIWA_API_TOKEN`             | vacío                          | Token rotado en secret store.                           |
| `LIWA_WEBHOOK_SECRET`        | placeholder en `.env.example`  | Secreto rotado y entregado solo mediante header.        |

## Bloqueadores externos

1. **Rotar credencial LIWA** antes de cualquier llamada real.
2. Dominio público estable para webhooks (sin Cloudflare quick tunnel).
3. Stack Compose del dialer desplegado junto a Hyperion (`infra/docker-compose.dialer.yml` overlay).
4. Configurar en LIWA los nodos de webhook hacia `https://<dominio>/v1/liwa/webhooks`.

## Migración Contabo → Hyperion

1. Desplegar Compose Hyperion + dialer.
2. Bootstrap tenant Coopfuturo (`POST .../nova/bootstrap`).
3. Importar contactos (CSV E.164) vía Ops UI.
4. Smoke E2E: llamada mock → post-call → WhatsApp flow mock → doc → handoff → CRM.
5. Activar dialer real en un tenant de prueba; comparar pacing/stats.
6. Activar LIWA live tras rotar secreto.
7. Retirar scripts `.sh` ad-hoc y secretos temporales del piloto.

## Smoke CI

Script: `scripts/autonomy/nova-smoke.e2e.mjs` (requiere stack levantado y credenciales de un operador NOVA de prueba).
El flujo usa login, cookies aisladas y CSRF; prueba además `403` cross-tenant y `404` cross-product. Voice puede quedar
como dependencia opcional sólo cuando `NOVA_SMOKE_REQUIRE_VOICE` no es `1`; no existe fallback mock autorizado.

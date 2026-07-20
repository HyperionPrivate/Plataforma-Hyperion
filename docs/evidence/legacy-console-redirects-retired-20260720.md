# Legacy shared-console redirects retired (DEBT-023)

Both legacy compatibility surfaces no longer emit productive redirects to NOVA / LUMEN / PULSO origins.

## `apps/web-console`

- `resolveLegacyRedirect()` always returns `undefined`.
- Unknown legacy paths render the static 404 shell (“La consola compartida fue retirada”).

## `infra/docker/legacy` (nginx edge)

- Former locations (`/nova`, `/lumen*`, `/`, `/conversaciones*`, `/operacion`, `/agenda`, `/rpa`, `/campanas`, `/bi`, `/configuracion`) return **404** JSON (`legacy console redirects retired`).
- No `307`/`308` Location responses; `NOVA_CONSOLE_ORIGIN` / `LUMEN_CONSOLE_ORIGIN` / `PULSO_CONSOLE_ORIGIN` removed from image and Compose.
- Access logs keep safe structured telemetry (`legacy_console_retired`) with product classification and query disposition only — never `$args`, `$request_uri`, or Location.

Product entry is hostname-edge / direct console URLs only (`docs/operations/HOSTNAME-EDGE.md`).

Residual observation (ops): confirm edge access logs show no dependency on legacy redirects before deleting the empty shell package / nginx edge service in a later cut.

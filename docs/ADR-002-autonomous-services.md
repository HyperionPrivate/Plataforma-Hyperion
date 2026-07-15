# ADR-002 — Microservicios autónomos

## Estado

Aceptado — 2026-07-14

## Contexto

Varias personas deben desarrollar en paralelo sin bloquearse. Un monolito o un “shared kernel” acopla deploys y ownership.

## Decisión

Cada servicio bajo `services/`:

- Tiene Dockerfile, `.env.example`, README y proceso propios.
- Usa una database dedicada (`db_<name>`).
- Expone `/health` y `/health/ready`.
- No importa código de otros servicios.
- Comparte solo esquemas versionados en `contracts/`.

El gateway es Traefik (infra), no un servicio de dominio.

## Consecuencias

- Más contenedores y contratos que mantener.
- Deploy y CI pueden filtrar por path.
- Cambios de contrato requieren versionado explícito.

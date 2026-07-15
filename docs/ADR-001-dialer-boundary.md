# ADR-001 — Límite del Dialer

> **Supersedido por:** [adr/ADR-003-external-dialer.md](adr/ADR-003-external-dialer.md). Mantener solo como referencia histórica.

## Estado

Aceptado — 2026-07-14

## Contexto

Existe un stack de voz maduro (Dialer + ASR + AMD) fuera de este monorepo. El piloto Coopfuturo necesita voz saliente, pero también WhatsApp, CRM, compliance y handoff.

## Decisión

- El Dialer **permanece en su propio repositorio**.
- Este monorepo **no** lo forkeará ni lo copiará como código.
- Solo el microservicio **orchestrator** es cliente HTTP del Dialer.
- ASR y AMD siguen siendo companions del Dialer, no servicios de este monorepo.

## Consecuencias

- Equipos de voz y de negocio trabajan en repos distintos.
- Orchestrator debe mapear webhooks/resultados del Dialer a eventos internos (`call.completed`).
- Configuración vía `DIALER_BASE_URL` / `DIALER_API_TOKEN` solo en orchestrator.

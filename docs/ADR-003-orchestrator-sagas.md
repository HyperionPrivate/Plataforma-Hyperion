# ADR-003 — Orchestrator limitado a sagas

## Estado

Aceptado — 2026-07-14

## Contexto

Un orquestador que concentra funnels, tipificaciones y reglas de canal se convierte en monolito y cuello de botella de ownership.

## Decisión

`orchestrator`:

- Coordina sagas/coreografía (pasos HTTP + eventos).
- Es el **único** cliente del Dialer.
- No posee `funnel_state` (eso es CRM).
- No implementa protocolo WhatsApp ni SIP.
- No calcula scoring (segmentation) ni valida PDFs (documents).

Ejemplo de saga renovación (futura):

1. compliance.eligibility
2. crm.get/update state
3. agent-config.resolve
4. dialer.create_call (solo orchestrator)
5. emitir / reaccionar a eventos

## Consecuencias

- Flujos más explícitos y testeables por contrato.
- CRM y canales pueden evolucionar sin tocar Dialer.
- Hay que evitar “callback hell” documentando sagas en el README del orchestrator.

# Backlog de retiro de deuda de fronteras (fase 7+)

Referencia: [ADR-0005](decisions/ADR-0005-boundary-debt-retirement.md).
NOVA y LUMEN son la plantilla: esquemas propios, sin FKs a `platform.tenants`, sin SQL cruzado.

## Cola ordenada (una pieza por PR)

1. **Integration → PULSO SQL** (`integration-service` lee `agenda_settings` / `availability_rules` / `professionals`)
   - Reemplazar por HTTP a `pulso-iris-service` con `INTEGRATION_TO_PULSO_TOKEN`.
   - Retirar 3 entradas `sql-access|...integration-adapter->pulso-core...` del baseline.
2. **Integration → SOFÍA SQL** (`platform.agents` / `prompt_flows`)
   - HTTP a agent/prompt-flow; retirar 2 entradas.
3. **SOFÍA → PULSO SQL** (`sofia-runtime` lee patients/conversations/messages)
   - Proyecciones locales o eventos; retirar entradas `sofia-automation->pulso-core`.
4. **SOFÍA → Channel SQL** (`outbound_messages`)
   - Inbox/eventos Channel; retirar entrada.
5. **PULSO → Audit SQL directo**
   - Solo outbox → audit-service.
6. **FKs históricas a `platform.tenants`**
   - Expand/migrate/contract por tabla; no reescribir migraciones aplicadas (checksums).
7. **Cadena única de migraciones**
   - Cada contexto nuevo sigue `schema_version` local (como LUMEN/NOVA).

## Regla

Cada PR que elimine una violación elimina la entrada correspondiente de
`boundary-baseline.json` en el mismo cambio. `check-boundaries` debe quedar verde
y el conteo del baseline no puede subir.

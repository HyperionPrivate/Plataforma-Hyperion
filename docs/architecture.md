# Arquitectura Coopfuturo

Monorepo de **microservicios autónomos** para el piloto PULSO (voz + WhatsApp + CRM + compliance).

## Topología

```text
Cliente
   │
   ▼
Traefik (gateway fino)
   │
   ├── /orchestrator  → orchestrator  → Dialer externo (único)
   ├── /crm           → crm
   ├── /compliance    → compliance
   ├── /whatsapp      → whatsapp
   ├── /identity      → identity
   ├── /documents     → documents
   ├── /handoff       → handoff
   ├── /segmentation  → segmentation
   ├── /agent-config  → agent-config
   └── /analytics     → analytics

Postgres: db_<servicio> por servicio
Redis: bus de eventos (futuro)
```

## Reglas

1. Autonomía: imagen, env, DB y deploy propios.
2. Sin shared kernel Python; solo `contracts/` versionados.
3. Orchestrator = sagas; CRM = funnel_state; canales = adaptadores.
4. Solo orchestrator llama al Dialer.
5. Propagar `X-Correlation-ID` / `correlation_id`.

## Prioridad

- **Core:** orchestrator, crm, compliance, whatsapp, identity
- **Satélite:** documents, handoff, segmentation, agent-config, analytics

## Referencias

- [Ownership](service-ownership.md)
- [Anti-patrones](anti-patterns.md)
- [ADR-001 Dialer](ADR-001-dialer-boundary.md)
- [ADR-002 Autonomía](ADR-002-autonomous-services.md)
- [ADR-003 Sagas](ADR-003-orchestrator-sagas.md)
- [ADR-004 Canales](ADR-004-channel-adapters.md)

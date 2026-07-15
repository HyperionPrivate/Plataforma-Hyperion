# Flujos HTTP

> **Alcance:** fundación arquitectónica. **No hay features comerciales de producto implementadas todavía.**

## Topología

```text
Cliente / UI
    │
    ▼
Traefik (edge) ── OIDC/JWT (futuro)
    │
    ├── GET  /pilot-core/health     → pilot-core
    ├── GET  /whatsapp/health       → whatsapp-adapter
    ├── GET  /documents/health      → documents
    └── GET  /handoff-liwa/health    → handoff-liwa
```

## Flujos síncronos planificados

### 1. Intento de contacto por voz

```mermaid
sequenceDiagram
    participant Op as Operador
    participant GW as Traefik
    participant PC as pilot-core
    participant Comp as compliance
    participant Orch as orchestration
    participant D as Dialer externo

    Op->>GW: POST /pilot-core/campaigns/{id}/enroll
    GW->>PC: JWT validado
    PC->>Comp: eligibility check
    Comp-->>PC: approved
    PC->>Orch: contact.attempt.requested
    Orch->>D: POST /calls (HTTP)
    D-->>Orch: call_id
    Orch-->>PC: call.dispatched
```

### 2. Envío WhatsApp

```mermaid
sequenceDiagram
    participant PC as pilot-core
    participant WA as whatsapp-adapter
    participant LIWA as LIWA (mock)

    PC->>WA: event wa.send.requested (async) o POST interno
    WA->>LIWA: send message (mock)
    LIWA-->>WA: message_id
    WA-->>PC: wa.message.sent (evento)
```

### 3. Handoff humano

```mermaid
sequenceDiagram
    participant CRM as pilot-core/crm
    participant HO as handoff-liwa
    participant LIWA as LIWA (mock)

    CRM->>HO: event lead.qualified
    HO->>LIWA: create case (mock)
    HO-->>CRM: handoff.created (evento)
```

## Auth HTTP

| Capa | Mecanismo | ADR |
|---|---|---|
| Edge → apps | JWT OIDC | [ADR-007](../adr/ADR-007-oidc-jwt-auth.md) |
| App → app | Service token | [ADR-008](../adr/ADR-008-service-to-service-auth.md) |
| orchestration → Dialer | API token dedicado | [ADR-003](../adr/ADR-003-external-dialer.md) |

## Webhooks entrantes

| Origen | Destino | Validación |
|---|---|---|
| Dialer | pilot-core/orchestration | Token/HMAC TBD |
| LIWA/WABA | whatsapp-adapter | Firma proveedor TBD |

## Trust boundaries

Ver [trust-boundaries.md](trust-boundaries.md).

## Estado actual

Solo endpoints `/health` implementados. Flujos anteriores son diseño target.

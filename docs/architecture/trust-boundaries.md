# Límites de confianza (trust boundaries)

> **Alcance:** fundación arquitectónica. **No hay features comerciales de producto implementadas todavía.**

## Diagrama de zonas

```mermaid
flowchart TB
    subgraph public [Zona pública]
        Internet((Internet))
    end

    subgraph edge [Zona edge]
        Traefik[Traefik / WAF]
    end

    subgraph app [Zona aplicación — coopfuturo_app]
        PC[pilot-core]
        WA[whatsapp-adapter]
        DOC[documents]
        HO[handoff-liwa]
    end

    subgraph data [Zona datos — coopfuturo_data]
        PG[(PostgreSQL)]
        Redis[(Redis)]
        S3[(Object storage)]
    end

    subgraph external [Zona externa no confiable]
        Dialer[Dialer]
        LIWA[LIWA]
        IdP[IdP OIDC]
        Core[Core financiero]
    end

    Internet --> Traefik
    Traefik --> PC & WA & DOC & HO
    PC & WA & DOC & HO --> PG & Redis
    DOC --> S3
    PC --> Dialer
    WA & HO --> LIWA
    Traefik --> IdP
    PC --> Core
```

## Matriz de confianza

| Frontera | Confianza | Controles |
|---|---|---|
| Internet → Edge | Ninguna | TLS, JWT OIDC, rate limiting (futuro) |
| Edge → Apps | Baja | Validación JWT, headers sanitizados |
| App ↔ App (HTTP) | Media | Service tokens, red privada |
| App → Data | Alta | Least privilege DB roles, sin cross-DB |
| App → Externos | Ninguna | Tokens dedicados, timeouts, circuit breaker |
| Webhooks externos → App | Ninguna | HMAC/firma, IP allowlist, replay protection |

## Reglas críticas

1. **Dialer:** solo `pilot-core.orchestration` puede invocar ([ADR-003](../adr/ADR-003-external-dialer.md)).
2. **PII:** no cruza a analytics ni logs sin clasificación ([ADR-011](../adr/ADR-011-pii-handling.md)).
3. **Secretos:** nunca en repo; LIWA histórica rotada externamente ([ADR-009](../adr/ADR-009-secrets-strategy.md)).
4. **Postgres/Redis:** bind `127.0.0.1` en local; no expuestos a Internet.

## Redes Docker (local)

| Red | Miembros |
|---|---|
| `coopfuturo_edge` | Traefik, apps |
| `coopfuturo_app` | Apps |
| `coopfuturo_data` | Postgres, Redis, MinIO |

## Ownership seguridad

`@TBD-security` — confirmar en [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md).

# Contribuir — Coopfuturo / PULSO

## Antes de codear

1. Lee [BRANCH_POLICY](docs/BRANCH_POLICY.md), [ADR-005](docs/ADR-005-modular-first.md) y [anti-patterns](docs/anti-patterns.md).
2. Trabaja en rama `feat|fix|chore|security/...` — **nunca commits en `main`**.
3. Confirma owners en [OWNERSHIP_REQUEST](docs/OWNERSHIP_REQUEST.md) si tocas CODEOWNERS.

## Dónde implementar

| Trabajo nuevo | Ubicación |
|---|---|
| Dominio piloto (contactos, CRM, compliance, voz orchestration, …) | `apps/pilot-core/` |
| WhatsApp / LIWA | `apps/whatsapp-adapter/` |
| Documentos | `apps/documents/` |
| Handoff | `apps/handoff-liwa/` |
| Contratos | `contracts/` |
| Stubs legacy | `services/` — solo mantenimiento; no features nuevas |

## Comandos

```powershell
make bootstrap
make format
make lint
make typecheck
make test
make contracts
make build
make smoke
make security
make e2e
```

## Reglas

1. Sin secretos reales ni PII de producción en Git, logs o fixtures.
2. Solo orchestration (en pilot-core) habla con el Dialer.
3. Credencial LIWA histórica expuesta = comprometida; no reutilizar.
4. Integraciones sin credencial: interfaz + adaptador **mock** etiquetado + bloqueo documentado.
5. Políticas legales (horarios, RNE, habeas data) = configurables; validación jurídica externa.
6. Breaking change de eventos → `v2` + `contracts/CHANGELOG.md` + `CHANGELOG.md`.
7. PRs pequeños por fase; CI debe quedar verde.

## Path filters (CI)

Cuando exista CI, validar preferentemente la unidad tocada (`apps/pilot-core/**`, etc.).

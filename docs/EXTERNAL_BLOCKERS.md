# Acciones externas pendientes (bloqueos)

No están resueltas en código. No fingir integraciones reales.

> **LIWA:** Cualquier credencial LIWA que haya aparecido en documentación externa se considera **comprometida**. **DEBE rotarse externamente** (fuera de este repositorio) antes de habilitar integración real. Hasta entonces: `LIWA_MODE=mock` obligatorio. Ver [ADR-009](adr/ADR-009-secrets-strategy.md) y [runbooks/secret-rotation.md](runbooks/secret-rotation.md).

| Acción | Estado | Impacto |
|---|---|---|
| Rotar credencial LIWA histórica expuesta (docs externos) | **Obligatoria — acción externa** | Bloquea adaptador LIWA real; nunca almacenar token real en repo |
| Provisionar token LIWA nuevo en secret manager | Pendiente | whatsapp-adapter / handoff |
| Confirmar owners GitHub reales | Pendiente | CODEOWNERS enforce |
| Configurar IdP OIDC (issuer, audience, JWKS) | Pendiente | Auth productiva |
| Confirmar contrato OpenAPI del Dialer productivo | Pendiente | orchestration |
| Confirmar API core financiero Coopfuturo | Pendiente | core_adapter |
| Validación jurídica de políticas de contacto (horarios, RNE, finalidad) | Pendiente | compliance policies |

Mientras tanto: interfaces + **mocks** etiquetados + tests.

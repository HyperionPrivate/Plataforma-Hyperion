# Decisiones arquitectónicas

Los ADR registran decisiones que cambian límites de producto, propiedad de datos, seguridad o capacidad de
despliegue. Un ADR puede aplicar solo a un corte de demostración y dejar explícita una decisión de producción
pendiente.

| ADR                                                   | Estado                                      | Decisión                                                                          |
| ----------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| [ADR-0001](ADR-0001-product-service-boundaries.md)    | Reemplazada parcialmente por ADR-0006       | Separar producto comercial de contexto técnico desplegable.                       |
| [ADR-0002](ADR-0002-lumen-audio-retention.md)         | Aceptada para la demo; producción bloqueada | Mantener el audio clínico como temporal hasta aprobar una política de producción. |
| [ADR-0003](ADR-0003-nova-product-boundaries.md)       | Reemplazada parcialmente por ADR-0006       | Reconocer NOVA como producto y definir sus primeros contextos autónomos.          |
| [ADR-0004](ADR-0004-neutral-dialer-external-voice.md) | Aceptada                                    | Mantener Neutral Dialer v3 externo y acceder a él únicamente mediante Voice.      |
| [ADR-0005](ADR-0005-boundary-debt-retirement.md)      | Aceptada                                    | Retirar cada excepción de frontera junto con el cambio que elimina la deuda.      |
| [ADR-0006](ADR-0006-federated-product-cells.md)       | Aceptada                                    | Separar células de producto y transitar del monorepo a repositorios federados.    |

Cuando un ADR aparece como reemplazado parcialmente, sus decisiones no señaladas por el ADR posterior continúan
vigentes. La sección de reemplazo del ADR más reciente es la fuente normativa para resolver la superposición.

Los ADR no sustituyen una revisión legal, clínica o de seguridad cuando el cambio requiere esas autoridades.

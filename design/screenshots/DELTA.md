# Visual QA — deltas

Comparar UI en `apps/web` vs `design/mockups/pulso_0*.png` (aprobados).

| Pantalla | Mockup | Estado | Gaps vs mockup |
|---|---|---|---|
| Dashboard | `pulso_01` | Interactivo mock | Filtros canal/segmento OK; date picker aún estático |
| Campañas | `pulso_02` | Heatmap con ejes + leyenda | Buscador/paginación tabla pendientes |
| Conversaciones | `pulso_03` | Switch + tomar control + composer | OK para demo mock |
| CRM | `pulso_04` | Tabs cambian funnel | Ficha 360 sigue toast |
| Handoff | `pulso_05` | Cola alineada con Conversaciones | Atender → `/conversaciones` |
| Segmentación | `pulso_06` | 4 cuadrantes + colores segmento | OK para demo mock |
| Reportes | — | OK (usuario) | Sin mockup dedicado |
| Configuración | `pulso_07` | OK (usuario) | — |

## Criterio

- Interacciones mock no dependen de backend live.
- White-label: sin nombres de proveedores externos.

# NOVA

Producto de campañas de contacto proactivo (voz IA + WhatsApp) para renovación, reactivación y
cobranza. **Coopfuturo es el primer tenant**, no el nombre del producto.

NOVA es una celda de producto. `nova-core-service`, Voice, LIWA y Documents pertenecen a ella mientras no exista
un segundo consumidor real. `nova-console` es la consola genérica del producto y `coopfuturo-console` continúa
siendo una aplicación específica del cliente; ninguna debe seleccionar un tenant por slug o semilla implícita.

## Contexto

| ID      | Requisito                                                                                | Estado     | Límite vigente                                                                                                                      |
| ------- | ---------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| NOV-001 | Importar contactos E.164 con deduplicación.                                              | `parcial`  | Falta probar volumen, aislamiento por tenant y repetición de archivos completos.                                                    |
| NOV-002 | Calcular segmentación y scoring antes de orquestar contacto.                             | `parcial`  | El scoring aún no usa features aprobadas del core financiero por tenant.                                                            |
| NOV-003 | Aplicar compliance gate de ventana horaria, opt-out y frecuencia antes de cada contacto. | `parcial`  | Faltan festivos, políticas completas por tenant y cobertura de todos los caminos de despacho.                                       |
| NOV-004 | Despachar voz por Voice hacia Neutral Dialer v3 mediante un contrato estable.            | `parcial`  | El adaptador existe, pero no hay cutover vigente ni smoke del release objetivo.                                                     |
| NOV-005 | Decidir de forma trazable la acción WhatsApp posterior a una llamada.                    | `parcial`  | La decisión existe; faltan política aprobada por tenant y reconciliación E2E.                                                       |
| NOV-006 | Mantener el funnel CRM y la tipificación derivados de outcomes verificables.             | `parcial`  | El lifecycle está implementado parcialmente y no está reconciliado con un core financiero real.                                     |
| NOV-007 | Entregar handoff por sede y grupo asesor sin grants implícitos.                          | `parcial`  | El primer tenant conserva nueve agencias sembradas; faltan grants normativos y concurrencia E2E.                                    |
| NOV-008 | Registrar CSAT y outcomes del core financiero sin acoplar NOVA al ledger externo.        | `simulado` | El adaptador local simula el sistema financiero y no acredita una integración operativa.                                            |
| NOV-009 | Persistir documentos mediante Documents y object storage S3-compatible.                  | `parcial`  | Falta validar almacenamiento objetivo, retención, inspección de contenido y recuperación.                                           |
| NOV-010 | Proveer una UI operativa con grants admin, supervisor y asesor por tenant/producto.      | `parcial`  | Las consolas usan sesión HttpOnly/CSRF y grants por tenant/producto; falta cerrar la matriz de roles y probar 403 E2E en cada ruta. |
| NOV-011 | Mantener analytics diarios sin PII como read-model operativo.                            | `parcial`  | Faltan objetivos de frescura, reconciliación y pruebas con volumen representativo.                                                  |
| NOV-012 | Operar Dialer, LIWA y ElevenLabs reales detrás de configuración fail-closed.             | `parcial`  | Existen adaptadores, pero los runbooks están no vigentes y falta un ensayo por digest.                                              |
| NOV-013 | Propagar `contact_id` y `enrollment_id` en voz y eventos post-call.                      | `parcial`  | Falta exigir correlación en todos los webhooks, pollers y caminos de reconciliación.                                                |
| NOV-014 | Recuperar outcomes del dialer mediante poller/reconciliación cuando falte el webhook.    | `parcial`  | Falta probar pérdida real de webhook, deduplicación y recuperación bajo carga.                                                      |
| NOV-015 | Aplicar review gate post-call para aprobar, omitir o autoenviar WhatsApp según política. | `parcial`  | La política global debe convertirse en configuración por tenant con auditoría.                                                      |
| NOV-016 | Enviar y recibir WhatsApp mediante LIWA, incluida ventana de 24 h y webhooks.            | `parcial`  | Falta cutover HTTPS vigente, secreto rotado y smoke real reproducible.                                                              |
| NOV-017 | Mover outbox agotado a DLQ por contexto y permitir listado/redrive auditado.             | `parcial`  | Faltan alertas, retención y prueba E2E de redrive para cada componente.                                                             |
| NOV-018 | Listar/buscar contactos y avanzar el lifecycle de `campaign_enrollments`.                | `parcial`  | Falta cerrar enrolamiento desde la UI, métricas y pruebas de concurrencia.                                                          |
| NOV-019 | Normalizar webhooks LIWA a un contrato canónico sin depender de aliases del piloto.      | `parcial`  | Falta validación con eventos reales tras un cutover HTTPS aprobado.                                                                 |

El [cutover Dialer](nova/CUTOVER-DIALER.md) está marcado como no vigente hasta su revalidación. La evidencia por
requisito se mantiene en [REQUIREMENTS-TRACEABILITY.md](REQUIREMENTS-TRACEABILITY.md).

## Contextos técnicos

Ver [ADR-0003](../architecture/decisions/ADR-0003-nova-product-boundaries.md),
[ADR-0004](../architecture/decisions/ADR-0004-neutral-dialer-external-voice.md) y
[ADR-0006](../architecture/decisions/ADR-0006-federated-product-cells.md).

## Roles y sedes

- **admin**: configuración, usuarios, todo el negocio.
- **supervisor**: campañas, import, orquestación, CRM.
- **asesor**: conversaciones y handoff solo de sus sedes (claim + respuesta en ventana 24h).

La configuración específica de Coopfuturo incluye Barranquilla, Bucaramanga, Cúcuta, Floridablanca, Piedecuesta,
San Gil, Barrancabermeja, Valledupar y Villavicencio. Ese catálogo pertenece a la aplicación cliente: una
instalación NOVA genérica debe arrancar vacía y recibir el mapa sede→grupo→asesor por tenant autorizado.

## Naming

El piloto se autodenominaba "PULSO". Ese nombre **no se usa** en Hyperion para este producto
(colisión con PULSO IRIS). Producto = **NOVA**. Tenant piloto = **coopfuturo**.

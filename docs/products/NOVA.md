# NOVA

Producto de campañas de contacto proactivo (voz IA + WhatsApp) para renovación, reactivación y
cobranza. **Coopfuturo es el primer tenant**, no el nombre del producto.

## Contexto

| ID      | Requisito                                                           | Estado             |
| ------- | ------------------------------------------------------------------- | ------------------ |
| NOV-001 | Importar contactos E.164 con deduplicación                          | parcial            |
| NOV-002 | Segmentación y scoring                                              | parcial            |
| NOV-003 | Compliance gate (ventana horaria, opt-out) obligatorio pre-contacto | parcial            |
| NOV-004 | Campañas de voz vía voice-channel → Neutral Dialer v3               | parcial (mock)     |
| NOV-005 | Post-call → decisión WhatsApp (flow LIWA)                           | parcial (mock)     |
| NOV-006 | CRM funnel + tipificación                                           | parcial            |
| NOV-007 | Handoff por sede (9 agencias, grupos de asesores)                   | parcial            |
| NOV-008 | CSAT y outcome del core financiero                                  | parcial (simulado) |
| NOV-009 | Documentos vía documents-service (object storage)                   | parcial (mock)     |
| NOV-010 | Ops UI multi-rol (admin/supervisor/asesor)                          | parcial            |
| NOV-011 | Analytics read-model sin PII                                        | parcial            |
| NOV-012 | Integración real Dialer + LIWA + ElevenLabs detrás de flags         | pendiente          |
| NOV-013 | Correlación contact_id / enrollment_id en voz y post-call           | parcial            |
| NOV-014 | Outcome poller / reconciliación dialer                              | parcial            |
| NOV-015 | Post-call review gate (approve/skip WhatsApp)                       | parcial            |
| NOV-016 | Canal LIWA (flows, ventana 24h, webhooks)                           | parcial            |
| NOV-017 | Outbox DLQ + redrive por contexto                                   | parcial            |

Cutover dialer: [nova/CUTOVER-DIALER.md](nova/CUTOVER-DIALER.md). Trazabilidad: [REQUIREMENTS-TRACEABILITY.md](REQUIREMENTS-TRACEABILITY.md).

## Contextos técnicos

Ver [ADR-0003](../architecture/decisions/ADR-0003-nova-product-boundaries.md) y
[ADR-0004](../architecture/decisions/ADR-0004-neutral-dialer-external-voice.md).

## Roles y sedes

- **admin**: configuración, usuarios, todo el negocio.
- **supervisor**: campañas, import, orquestación, CRM.
- **asesor**: conversaciones y handoff solo de sus sedes (claim + respuesta en ventana 24h).

Agencias iniciales (tenant Coopfuturo): Barranquilla, Bucaramanga, Cúcuta, Floridablanca,
Piedecuesta, San Gil, Barrancabermeja, Valledupar, Villavicencio. El mapa sede→grupo→asesor es
configurable por tenant.

## Naming

El piloto se autodenominaba "PULSO". Ese nombre **no se usa** en Hyperion para este producto
(colisión con PULSO IRIS). Producto = **NOVA**. Tenant piloto = **coopfuturo**.

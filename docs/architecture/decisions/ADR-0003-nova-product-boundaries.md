# ADR-0003: Producto NOVA y contextos autónomos

- Estado: Aceptada
- Fecha: 2026-07-16

## Contexto

El piloto Coopfuturo (campañas de contacto proactivo por voz IA y WhatsApp para renovación/cobranza)
nació fuera de Hyperion con arquitectura modular documentada, pero con implementación desordenada
(SQLite compartido, satélites vacíos, bypass del dialer, login solo-admin). Hyperion ya separa
producto comercial de límite técnico en ADR-0001. Se necesita incorporar ese dominio como producto
autónomo sin heredar la deuda de base compartida ni colisionar con PULSO IRIS.

**Coopfuturo es el primer tenant**, no el nombre del producto. El producto es una capacidad genérica
de campañas de contacto proactivo (voz + WhatsApp). Nombre de trabajo: **NOVA**.

## Decisión

1. **NOVA es un producto de software** en Hyperion, distinto de PULSO IRIS y LUMEN.
2. Contextos técnicos del producto y capacidades compartidas nuevas:

   | Contexto / servicio                       | Owner       | Responsabilidad                                                                               |
   | ----------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
   | `nova-core` → `nova-core-service`         | `nova-core` | Contactos, campañas, compliance, segmentación, CRM, handoff por sede, orquestación, analytics |
   | `documents` → `documents-service`         | `documents` | Metadatos y object storage de documentos                                                      |
   | `voice-channel` → `voice-channel-service` | `voice`     | Capacidad compartida de voz; único cliente del Neutral Dialer v3                              |
   | `liwa-channel` → `liwa-channel-service`   | `liwa`      | Capacidad compartida WhatsApp vía LIWA (bot de flujos)                                        |

3. **Base lógica propia por contexto desde el día 1**, sin FKs cruzadas a `platform.tenants`.
   `tenant_id` es identificador lógico opaco. Cada contexto tiene esquema, rol PostgreSQL,
   migraciones locales (`schema_version`) y outbox/inbox propios.
4. Reutiliza capacidades transversales: `access` (identity+tenant), `audit`, `api-gateway`, `web-console`.
5. El producto se registra en `platform.products` como `NOVA`. El tenant demo/piloto se llama `coopfuturo`.
6. Construcción **cosa por cosa** (vertical slices) según
   [VERTICAL-SLICE-METHOD.md](../VERTICAL-SLICE-METHOD.md).

## Consecuencias

- NOVA nace sin la deuda de FKs/SQL cruzado que arrastra PULSO/SOFÍA/Channel.
- Se añaden cuatro roles PostgreSQL y cuatro esquemas gestionados.
- La Ops UI de Coopfuturo se porta a `web-console` con roles admin/supervisor/asesor y alcance por sede.
- PULSO IRIS no se modifica para absorber cobranza; la colisión de nombre "PULSO" del piloto se
  resuelve renombrando el producto a NOVA en documentación y UI.

## Alternativas descartadas

- Extender PULSO IRIS: acoplaría cobranza al dominio de agenda clínica/administrativa.
- Reescribir el Neutral Dialer en TypeScript: el dialer ya es autónomo y disciplinado; se integra
  como microservicio externo (ADR-0004).

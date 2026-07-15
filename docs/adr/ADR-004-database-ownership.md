# ADR-004 — Ownership de base de datos por unidad

## Estado

Accepted — 2026-07-15

## Contexto

Compartir una base de datos entre unidades desplegables crea acoplamiento de schema, riesgo de escritores múltiples y violación de bounded contexts.

**Alcance actual:** bases y roles definidos en infra local; sin migraciones productivas ni datos reales.

## Decisión

1. **Una base de datos PostgreSQL por unidad desplegable:**

   | Unidad | Database | Rol de aplicación |
   |---|---|---|
   | `pilot-core` | `db_pilot_core` | `app_pilot_core` |
   | `whatsapp-adapter` | `db_whatsapp` | `app_whatsapp` |
   | `documents` | `db_documents` | `app_documents` |
   | `handoff-liwa` | `db_handoff` | `app_handoff_liwa` |

2. **Least privilege:**
   - Cada unidad usa solo su rol `app_*`; nunca credenciales de superusuario ni `POSTGRES_USER` en runtime de aplicación.
   - Sin acceso cross-database: una unidad no puede conectarse a la DB de otra.

3. **Un solo escritor canónico** por agregado de dominio (ver [data-ownership-matrix.md](../architecture/data-ownership.md)).

4. Lectura cruzada entre unidades **prohibida** a nivel SQL; sincronización vía eventos (Redis Streams) o APIs HTTP con contratos.

5. Migraciones: propiedad del owner de la unidad (TBD → ver [OWNERSHIP_REQUEST.md](../OWNERSHIP_REQUEST.md)).

## Consecuencias

- Operaciones de backup/restore independientes por unidad.
- Joins cross-domain solo en capa analítica externa (warehouse), no en runtime transaccional.
- Mayor número de conexiones y bases a administrar; aceptable para cuatro unidades iniciales.

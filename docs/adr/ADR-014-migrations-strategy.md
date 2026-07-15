# ADR-014 — Estrategia de migraciones de base de datos

## Estado

Accepted — 2026-07-15

## Contexto

Cada unidad desplegable posee su base de datos. Cambios de schema deben ser reproducibles, reversibles en dev y seguros en producción.

**Alcance actual:** init scripts de infra; sin herramienta de migraciones aplicada en apps.

## Decisión

1. **Herramienta:** Alembic (Python/SQLAlchemy) por unidad en `apps/<unit>/migrations/`.

2. **Ownership:** el owner de la unidad (TBD) aprueba migraciones que afecten su DB.

3. **Reglas:**
   - Migraciones **forward-only** en producción; rollback via migración compensatoria, no `downgrade` automático.
   - Cambios breaking (rename column, drop) en dos fases: expand → migrate data → contract.
   - Migraciones idempotentes donde sea posible; nunca datos de prueba con PII real.

4. **CI:** pipeline ejecuta migraciones contra Postgres efímero antes de merge.

5. **Orden de deploy:** migraciones antes de rollout de código que dependa del nuevo schema (expand/contract).

6. Procedimiento operativo: [runbooks/migrations.md](../runbooks/migrations.md).

## Consecuencias

- Cuatro pipelines de migración independientes.
- Coordinación necesaria cuando eventos dependen de campos nuevos cross-unit.
- Init script de infra (`init-databases.sh`) solo crea DBs/roles; schema vive en Alembic.

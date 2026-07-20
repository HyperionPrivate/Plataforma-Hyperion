---
documentType: runbook
status: draft
owner: platform-operations
issue: HYP-DEBT-005
reviewDue: 2026-10-31
---

# Access tenant projection replay

Status: current for Access→Channel (004), Iris (005), SOFIA (006), Integration (007) and Knowledge expand (008) + Access FK contract SQL (009–013) + N-1 drop (014) + SOFIA grant revoke (015).
Channel, Iris, SOFIA, Integration and Knowledge migrate gates read their local `tenant_snapshots` for
tenant-scoped eligibility. Tip migrations `009`–`013` contain append-only FK DROP SQL, but the
`@hyperion/pulso-migrations` runner refuses that cutover when operational data exists without a verified
multi-consumer parity receipt (DEBT-005). Identity may HTTP fan-out the same snapshot event to Channel, Iris,
Agent, Integration and Knowledge.

`access.tenant.snapshot.v1` is delivered at least once and applied exactly once at the logical level by Channel's
inbox. A `published` Access outbox row proves broker acceptance, not Channel application. Operators must therefore
use the checks below after a Channel restore or delivery incident.

## Preconditions

- Run the command with the `hyperion_identity` runtime role against the isolated Access logical database.
- Keep Access migration/role bootstrap on the current release. Runtime rollback never rolls back this control plane.
- Verify Channel migration 004 and the fixed durable `channel_access_tenant_snapshot_v1` are installed.
- Keep tenant lifecycle archive-only. The current feed has no hard-delete/tombstone contract.
- Do not compare provider and consumer payload hashes or `source_updated_at`; they intentionally have different
  meanings. Parity is tenant ID, status, source version and the current provider event ID.

## Reconcile and drain

Generate missing current snapshots in bounded batches:

```text
pnpm --filter @hyperion/identity-service tenant:projections -- reconcile --limit 100
```

Repeat while the result reports `hasMore: true`, then wait until the Access outbox has no `queued`, `processing`,
`retry_scheduled` or `dead_letter` rows. Never select tenants by slug.

## Exact dead-letter redrive

Inspect one terminal row and copy both UUIDs exactly. Then run:

```text
pnpm --filter @hyperion/identity-service tenant:projections -- redrive \
  --event-id <event-uuid> --tenant-id <tenant-uuid> \
  --confirm "REDRIVE ACCESS TENANT SNAPSHOT"
```

The update is constrained by `eventId × tenantId × status=dead_letter`. It preserves the event ID, payload and
source version. A missing exact match fails without changing any row.

## Rebuild a restored Channel projection

For each exact tenant whose current snapshot must be reapplied, wait at least three minutes after its `published_at`
and run:

```text
pnpm --filter @hyperion/identity-service tenant:projections -- replay \
  --tenant-id <tenant-uuid> --confirm "REPLAY ACCESS TENANT SNAPSHOT"
```

Replay requeues only the event matching Access's current watermark and preserves its original identity. The
three-minute fence exceeds the broker duplicate window, preventing a command that appears successful while the
broker suppresses it. On an intact Channel database the inbox returns `duplicate`; on a restored empty projection it
applies the same event once.

## Acceptance receipt

El rehearsal canónico usa un clúster PostgreSQL 16 efímero, crea dos bases lógicas, activa roles runtime separados,
arranca la aplicación WhatsApp Channel real en loopback y fuerza una caída antes del primer drain. No acepta una
base persistente ni credenciales entregadas por el operador. Ejecútelo explícitamente:

```powershell
$env:RUN_ACCESS_CHANNEL_ACCEPTANCE = "1"
pnpm federation:access-channel:acceptance -- --receipt access-channel-projection-receipt.json
Remove-Item Env:RUN_ACCESS_CHANNEL_ACCEPTANCE
```

El script etiqueta y elimina únicamente su contenedor `hyperion-access-channel-acceptance-<12 hex>` por nombre y
por labels de run, verifica que el inventario Docker preexistente quede idéntico y sella todos los campos del recibo
mediante JSON canónico + SHA-256.
El [recibo local verificado](../evidence/access-channel-projection-parity-20260719.json) acredita Access/PULSO
`004/004`, autenticación 401/403/400, tres tenants elegibles (el bootstrap se excluye por registro Access), cinco
eventos únicos, replay sin crecimiento del inbox y cobertura exacta `10000/10000`. Los gates exigen cero tenants
faltantes o extra, cero diferencias de status, versión o event ID actual, cero referencias huérfanas y cero
pendientes, dead letters o conflictos de `source_version` persistidos. No contiene tokens ni contraseñas.

La provenance es local y reproducible: fija revisión y branch, estado dirty mediante hashes de status/patch, hash
del harness, cierre de fuentes, artefactos construidos, versiones y hashes de Node/pnpm/Docker/Git, y el digest
solicitado/verificado de PostgreSQL. `publicationClaimed=false` y `registryReadbackPerformed=false`: este ensayo no
acredita publicación de artefactos.

Before any later migration removes Channel's five foreign keys to Access, record all of the following:

- equal sets of referenced tenant IDs;
- equal `status`, `sourceVersion` and current provider event ID for every projected tenant;
- zero missing or extra destination tenants and coverage `10000/10000` over every eligible Access tenant;
- all tenant IDs referenced by Channel operational tables exist locally;
- zero active or dead-letter Access outbox rows;
- zero persisted Channel inbox conflicts whose reason is `source_version`;
- producer, durable and consumer release digests plus the database migration ledgers.

Migration 004 is expansion only. Do not remove the five foreign keys or close the corresponding debt until a later
contract migration has this receipt and performs a locked, validated cutover.

## Required cutover order (Access FK contracts 009–013)

Apply FK DROP contracts only after this sequence. The gate in
`packages/pulso-migrations/src/access-fk-contract-gate.ts` enforces receipt presence when operational data exists.

1. **Transport ON** — HTTP fan-out and/or JetStream consumers delivering `access.tenant.snapshot.v1` to every
   destination (Channel, Iris, SOFIA, Integration, Knowledge).
2. **Backfill** — populate local `tenant_snapshots` for every eligible Access tenant:

```text
pnpm --filter @hyperion/identity-service tenant:projections -- backfill
```

(Use `reconcile --limit <n>` for bounded gap-fill until the dedicated `backfill` verb is available; drain
outbox/`dead_letter` as above.) 3. **Per-consumer receipts** — generate a sealed multi-consumer parity receipt with `consumers.*` at
`coverageBasisPoints` `10000` and zero mismatch/DLQ/conflict fields. The checked-in stub
`docs/evidence/access-fk-contract-parity-20260720.json` is `provisional-until-harness` and must **not** be
used as the operational receipt. 4. **Only then apply 009–013** — set env for the pulso-migrations runner:

```text
PULSO_ACCESS_FK_CONTRACT_RECEIPT=<path-to-sealed-receipt.json>
PULSO_ACCESS_FK_CONTRACT_RECEIPT_SHA256=<canonical-json-sha256>
```

Greenfield databases (empty operational tables and empty snapshots) may skip the receipt; any tenant operational
data refuses the contract migrations without a verified receipt.

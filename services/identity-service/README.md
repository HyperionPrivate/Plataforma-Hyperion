# Access / Identity

`identity-service` is the transitional name of the platform-owned Access plane. It keeps the N-1 opaque-session API while product BFFs move to brief RS256 tokens.

## HTTP contract

- `POST /v1/access/token` accepts `{ "email", "password" }` only from an allowlisted BFF workload. The required `x-hyperion-caller` determines the JWT `aud`; the request cannot select its own audience.
- `GET /.well-known/jwks.json` is public and contains public RS256 keys only.
- `GET /v1/auth/me` verifies a JWT locally, without a database lookup. It still resolves an existing opaque token through `platform.operator_sessions` during N/N-1.
- `POST /v1/auth/login` and `/v1/auth/logout` remain the temporary opaque-session endpoints.
- `/v1/access/operators/:operatorId/grants` and its tenant/product `PUT`/`DELETE` variants are neutral administration APIs.

Each BFF has a different workload credential: `NOVA_BFF_TO_ACCESS_TOKEN`, `LUMEN_BFF_TO_ACCESS_TOKEN`, `PULSO_BFF_TO_ACCESS_TOKEN`, and `PLATFORM_ADMIN_BFF_TO_ACCESS_TOKEN`. A credential for one caller is never accepted for another.

Issuance is audience-scoped: NOVA receives only `NOVA` grants, LUMEN only `LUMEN`, PULSO only `PULSO_IRIS`, and platform administration only the `PLATFORM` grant on the reserved control tenant `00000000-0000-4000-8000-000000000001`. That system tenant represents global control while preserving the normative `tenantId × productId × capabilities` shape; it is never selected as a customer tenant or looked up by slug at runtime. Only `platform-admin-bff` may mutate its `PLATFORM` grant.

JWTs larger than 3,500 bytes fail closed so the same-origin session remains below browser cookie limits. If one product outgrows that budget, the next protocol is a tenant-scoped token exchange rather than restoring cross-product or unbounded grants.

## Signing configuration

`ACCESS_TOKEN_ISSUER`, `ACCESS_TOKEN_AUDIENCES`, `ACCESS_TOKEN_KEY_ID`, and either `ACCESS_TOKEN_PRIVATE_KEY_FILE` (preferred) or `ACCESS_TOKEN_PRIVATE_KEY_PEM` configure issuance. `ACCESS_TOKEN_TTL_SECONDS` defaults to 300 and is restricted to 60–900 seconds. CI, staging, and production fail at startup when private signing material is absent. Local development may omit it only to exercise the N-1 opaque path.

Mount the private key at runtime; do not copy it into the repository or image. For a zero-downtime rotation:

1. Export the old **public** key as a standard JWKS document and mount it through `ACCESS_TOKEN_PREVIOUS_JWKS_FILE`.
2. Mount the new private key and change `ACCESS_TOKEN_KEY_ID`.
3. Deploy Access, then allow BFF JWKS caches to refresh.
4. Keep the old public key for at least the maximum token TTL plus clock skew and cache propagation time.
5. Remove the previous JWKS file in a later release.

The fresh Access logical database, grants and control-tenant registry are owned by `@hyperion/access-migrations`; they are intentionally absent from `packages/migrations/sql`. Readiness requires the exact fresh Access ledger (names, checksums, and no mixed rows). N−1 compatibility means the old binary remains on the legacy `platform-migrations` database during cutover; a new binary never claims that shared legacy database is ready. Identity accepts the previous metadata owner only for records copied through that controlled cutover. When both `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` are configured, Identity transactionally creates or verifies that admin, its control-tenant membership, and its single exact `PLATFORM/manage:platform` grant. Empty values disable the bootstrap; a partial configuration or missing Access migration aborts startup.

Identity preserves one recovery administrator across operator and control-grant mutations. Recovery authority means an active operator with an active `PLATFORM` grant on the reserved control tenant containing role `platform-admin` and capability `manage:platform`, matching the authorization consumed by `platform-admin-bff`. Legacy operator roles and tenant memberships do not add recovery authority. Mutations are serialized with a transaction-scoped advisory lock plus row locks; an authenticated administrator cannot disable itself or downgrade/revoke its own control grant.

## Access tenant snapshots

`access.tenant.snapshot.v1` is the provider-owned, product-neutral lifecycle feed. It projects every customer tenant
and excludes entries in `access_runtime.bootstrap_tenants`; it never selects tenants by slug, product grant, or
customer metadata. Its strict payload contains only `tenantId`, `status`, `sourceVersion`, and `sourceUpdatedAt`.
Per-tenant database locks serialize monotonic versions, and the durable outbox row is inserted before its state
watermark in the same transaction. Reconciliation selects only candidate IDs, then opens one transaction per tenant,
takes the same advisory lock and re-reads the source row. Future tenant mutation APIs must take that advisory lock too;
this prevents a stale page candidate from publishing a newer version with an older lifecycle state.

`ACCESS_TENANT_SNAPSHOT_TRANSPORT` is `disabled` by default and may be `http` or `jetstream`. HTTP requires an exact
HTTPS `ACCESS_TENANT_SNAPSHOT_HTTP_URL` endpoint and `ACCESS_TENANT_SNAPSHOT_HTTP_TOKEN`; a known Compose/loopback
HTTP host is accepted only with `ACCESS_TENANT_SNAPSHOT_ALLOW_PRIVATE_HTTP=true` in local/CI, never staging or
production. JetStream reuses the authenticated Access publisher identity. Enabled producers reconcile bounded pages using `ACCESS_TENANT_SNAPSHOT_RECONCILE_LIMIT`
and `ACCESS_TENANT_SNAPSHOT_RECONCILE_INTERVAL_MS`. Concurrent ticks share one serial run and immediate continuation
is capped, so a large backlog cannot monopolize startup or shutdown.

Dead-letter redrive and exact current-event replay preserve the provider event ID, version and payload. The
confirmation-gated recovery procedure is documented in
[ACCESS-TENANT-PROJECTION-REPLAY.md](../../docs/operations/ACCESS-TENANT-PROJECTION-REPLAY.md). Until an explicit
tombstone protocol exists, tenant lifecycle changes are archive-only. Access migration
`004-access-tenant-lifecycle-integrity.sql` owns that invariant at the source: its always-enabled trigger replaces caller-supplied
`updated_at` values on insert, advances the watermark strictly on every update, and rejects hard deletion with
SQLSTATE `55000` before existing cascades can remove projection state or outbox rows. Runtime roles cannot execute the
trigger function directly. A restore is not healthy unless that migrator-owned function, trigger and ACL survive.

## Access → LUMEN projections

LUMEN grant upserts/revocations and operator mutations persist the Access-owned tenant snapshot, effective operator
grant and durable outbox rows in the same transaction as their source mutation. A failed projection write rolls the
source mutation back; a failed delivery remains queued. Startup and the serialized periodic worker perform bounded,
reentrant reconciliation controlled by `ACCESS_LUMEN_BACKFILL_LIMIT` and
`ACCESS_LUMEN_RECONCILE_INTERVAL_MS`. `tenant-service` is read-only today, so there is no separate tenant mutation
endpoint to instrument; reconciliation covers changes made by provisioning/bootstrap paths until such an API exists.

`ACCESS_LUMEN_PROJECTION_TRANSPORT=http` remains the rollback transport and uses `ACCESS_TO_LUMEN_TOKEN`, caller
`identity-service`, strict LUMEN contracts and retryable leases. The JetStream overlay selects `jetstream`, gives
Access the dedicated `access` identity, and permits only the two `access.lumen.*` subjects plus the neutral
`access.tenant.snapshot.v1` feed consumed by Channel. Both transports drain their
same provider-owned outbox. The pending PULSO encounter-reference producer remains a separate PULSO domain decision.

Changed projection payloads persist their outbox row before advancing the Access watermark inside the same source
transaction. Terminal rows are never retried forever: the confirmation-gated command supports bounded
reconciliation, exact dead-letter redrive and exact replay of a current published `tenant_snapshot` or
`operator_grant` row. Replay reuses the event id, payload and versions and is a no-op when repeated. The selector and
verification procedure live in [LUMEN-PROJECTION-REPLAY.md](../../docs/operations/LUMEN-PROJECTION-REPLAY.md).

import type { DatabaseClient, DatabaseExecutor, DatabaseTransaction } from "@hyperion/database";
import {
  HttpOutboxDispatcher,
  JetStreamOutboxDispatcher,
  readNatsAuthentication,
  type HttpOutboxFailureCode,
  type HttpOutboxFetch,
  type JetStreamSessionFactory,
  type NatsAuthentication
} from "@hyperion/durable-events";
import {
  createInternalAuthorizationHeaders,
  isRestrictedDeploymentEnvironment,
  readInternalCredential
} from "@hyperion/service-runtime";
import { createHash, randomUUID } from "node:crypto";

export const ACCESS_LUMEN_TENANT_SNAPSHOT_EVENT = "access.lumen.tenant-snapshot.v1";
export const ACCESS_LUMEN_OPERATOR_GRANT_EVENT = "access.lumen.operator-grant.v1";

const LUMEN_PRODUCT_ID = "LUMEN";
const MAX_SOURCE_VERSION = Number.MAX_SAFE_INTEGER;
const DEFAULT_BACKFILL_LIMIT = 100;
const MAX_BACKFILL_LIMIT = 1_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const MIN_RECONCILE_INTERVAL_MS = 1_000;
const MAX_RECONCILE_INTERVAL_MS = 3_600_000;
const DEFAULT_BATCH_SIZE = 20;
const LUMEN_PROJECTION_PATH = "/internal/v1/events/lumen-projections";
const HYPERION_EVENTS_STREAM = "HYPERION_EVENTS";

export interface LumenGrantProjectionKey {
  readonly operatorId: string;
  readonly tenantId: string;
}

interface TenantSourceRow {
  tenantId: string;
  status: "active" | "paused" | "archived";
  isDemo: boolean;
  sourceUpdatedAt: Date | string;
}

interface OperatorGrantSourceRow {
  tenantId: string;
  operatorId: string;
  roles: string[];
  capabilities: string[];
  isActive: boolean;
  sourceUpdatedAt: Date | string;
}

interface ProjectionStateRow {
  sourceVersion: string | number;
  payloadHash: string;
}

interface ProjectionWrite {
  readonly kind: "tenant_snapshot" | "operator_grant";
  readonly aggregateId: string;
  readonly tenantId: string;
  readonly eventType: typeof ACCESS_LUMEN_TENANT_SNAPSHOT_EVENT | typeof ACCESS_LUMEN_OPERATOR_GRANT_EVENT;
  readonly sourceUpdatedAt: string;
  readonly payloadWithoutSource: Record<string, boolean | string>;
}

interface BackfillCandidateRow {
  tenantId: string;
  operatorId: string;
}

interface OperatorLumenGrantRow {
  tenantId: string;
}

interface ClaimedProjectionOutboxRow {
  id: string;
  tenantId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: Date | string;
  payload: Record<string, unknown>;
}

export interface AccessLumenProjectionResult {
  readonly eventsEnqueued: number;
}

export interface AccessLumenBackfillResult {
  readonly candidatesProcessed: number;
  readonly eventsEnqueued: number;
  readonly hasMore: boolean;
}

export type AccessLumenProjectionConfiguration =
  | { readonly transport: "disabled" }
  | {
      readonly transport: "http";
      readonly serviceUrl: string;
      readonly internalToken: string;
      readonly deliveryEnabled: boolean;
      readonly backfillLimit: number;
      readonly reconcileIntervalMs: number;
    }
  | {
      readonly transport: "jetstream";
      readonly natsUrl: string;
      readonly authentication: NatsAuthentication;
      readonly deliveryEnabled: boolean;
      readonly backfillLimit: number;
      readonly reconcileIntervalMs: number;
    };

export interface AccessLumenOutboxDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
  readonly destination: string;
}

export type AccessLumenProjectionKind = "tenant_snapshot" | "operator_grant";

export interface AccessLumenDeadLetterSelection {
  readonly eventId: string;
  readonly tenantId: string;
  readonly projectionKind: AccessLumenProjectionKind;
}

export interface AccessLumenDeadLetterRedrive {
  readonly eventId: string;
  readonly tenantId: string;
  readonly projectionKind: AccessLumenProjectionKind;
  readonly sourceVersion: string;
}

export type AccessLumenReplaySelection = AccessLumenDeadLetterSelection;

export interface AccessLumenReplayResult {
  readonly eventId: string;
  readonly tenantId: string;
  readonly projectionKind: AccessLumenProjectionKind;
  readonly aggregateId: string;
  readonly sourceVersion: string;
  readonly eventType: typeof ACCESS_LUMEN_TENANT_SNAPSHOT_EVENT | typeof ACCESS_LUMEN_OPERATOR_GRANT_EVENT;
  readonly eventVersion: 1;
}

export type AccessLumenProjector = (
  transaction: DatabaseTransaction,
  key: LumenGrantProjectionKey
) => Promise<AccessLumenProjectionResult>;

export type AccessLumenReconcile = (db: DatabaseClient, limit: number) => Promise<AccessLumenBackfillResult>;

/**
 * Executes a LUMEN grant mutation and both provider-owned projection writes in
 * one database transaction. A failed projection therefore rolls back the
 * grant; a failed HTTP delivery never does because delivery happens later.
 */
export function mutateLumenGrantWithProjection<T>(
  db: DatabaseClient,
  key: LumenGrantProjectionKey,
  mutation: (transaction: DatabaseTransaction) => Promise<T>,
  shouldProject: (result: T) => boolean = () => true,
  projector: AccessLumenProjector = enqueueAccessLumenProjections
): Promise<T> {
  return db.transaction(async (transaction) => {
    const result = await mutation(transaction);
    if (shouldProject(result)) await projector(transaction, key);
    return result;
  });
}

/**
 * Immediately refreshes every LUMEN grant whose effective state depends on an
 * operator mutation. The caller supplies the surrounding operator transaction,
 * so a failed snapshot write rolls the operator change back as well.
 */
export async function enqueueAccessLumenOperatorProjections(
  transaction: DatabaseTransaction,
  operatorId: string,
  projector: AccessLumenProjector = enqueueAccessLumenProjections
): Promise<AccessLumenProjectionResult> {
  const grants = await transaction.query<OperatorLumenGrantRow>(
    `select tenant_id as "tenantId"
       from access_runtime.product_grants
      where operator_id = $1 and product_id = $2
      order by tenant_id`,
    [operatorId, LUMEN_PRODUCT_ID]
  );
  let eventsEnqueued = 0;
  for (const grant of grants.rows) {
    const result = await projector(transaction, { operatorId, tenantId: grant.tenantId });
    eventsEnqueued += result.eventsEnqueued;
  }
  return { eventsEnqueued };
}

/** Produces the Access-owned tenant and effective-operator snapshots. */
export async function enqueueAccessLumenProjections(
  transaction: DatabaseTransaction,
  key: LumenGrantProjectionKey
): Promise<AccessLumenProjectionResult> {
  const tenantResult = await transaction.query<TenantSourceRow>(
    `select tenant.id as "tenantId",
            tenant.status,
            coalesce(lower(tenant.metadata->>'is_demo'), lower(tenant.metadata->>'isDemo'), 'false') = 'true'
              as "isDemo",
            tenant.updated_at as "sourceUpdatedAt"
       from platform.tenants tenant
      where tenant.id = $1`,
    [key.tenantId]
  );
  const tenant = tenantResult.rows[0];
  if (!tenant) throw new Error("LUMEN projection tenant source is missing");

  const grantResult = await transaction.query<OperatorGrantSourceRow>(
    `select grant_row.tenant_id as "tenantId",
            grant_row.operator_id as "operatorId",
            grant_row.roles,
            grant_row.capabilities,
            (grant_row.active and operator_row.status = 'active') as "isActive",
            greatest(grant_row.updated_at, operator_row.updated_at) as "sourceUpdatedAt"
       from access_runtime.product_grants grant_row
       join platform.operators operator_row on operator_row.id = grant_row.operator_id
      where grant_row.operator_id = $1
        and grant_row.tenant_id = $2
        and grant_row.product_id = $3`,
    [key.operatorId, key.tenantId, LUMEN_PRODUCT_ID]
  );
  const grant = grantResult.rows[0];
  if (!grant) throw new Error("LUMEN projection grant source is missing");

  const tenantWrite: ProjectionWrite = {
    kind: "tenant_snapshot",
    aggregateId: tenant.tenantId,
    tenantId: tenant.tenantId,
    eventType: ACCESS_LUMEN_TENANT_SNAPSHOT_EVENT,
    sourceUpdatedAt: toIsoDate(tenant.sourceUpdatedAt, "tenant sourceUpdatedAt"),
    payloadWithoutSource: {
      tenantId: tenant.tenantId,
      status: tenant.status,
      isDemo: tenant.isDemo
    }
  };
  const operatorWrite: ProjectionWrite = {
    kind: "operator_grant",
    aggregateId: grant.operatorId,
    tenantId: grant.tenantId,
    eventType: ACCESS_LUMEN_OPERATOR_GRANT_EVENT,
    sourceUpdatedAt: toIsoDate(grant.sourceUpdatedAt, "operator grant sourceUpdatedAt"),
    payloadWithoutSource: {
      tenantId: grant.tenantId,
      operatorId: grant.operatorId,
      role: selectLumenRole(grant.roles),
      isActive: grant.isActive,
      canReview:
        grant.isActive &&
        grant.capabilities.some((capability) => capability === "lumen:write" || capability === "lumen:admin")
    }
  };

  const tenantEvents = await writeProjection(transaction, tenantWrite);
  const operatorEvents = await writeProjection(transaction, operatorWrite);
  return { eventsEnqueued: tenantEvents + operatorEvents };
}

/**
 * Reconciles at most `limit` LUMEN grants. Re-running it is safe: unchanged
 * payloads only advance the provider watermark and cannot create another event.
 */
export async function backfillAccessLumenProjections(
  db: DatabaseClient,
  limit = DEFAULT_BACKFILL_LIMIT,
  projector: AccessLumenProjector = enqueueAccessLumenProjections
): Promise<AccessLumenBackfillResult> {
  const boundedLimit = normalizeBackfillLimit(limit);
  return db.transaction(async (transaction) => {
    const candidates = await transaction.query<BackfillCandidateRow>(
      `select grant_row.tenant_id as "tenantId", grant_row.operator_id as "operatorId"
         from access_runtime.product_grants grant_row
         join platform.tenants tenant on tenant.id = grant_row.tenant_id
         join platform.operators operator_row on operator_row.id = grant_row.operator_id
         left join access_runtime.lumen_projection_state tenant_state
           on tenant_state.projection_kind = 'tenant_snapshot'
          and tenant_state.tenant_id = grant_row.tenant_id
          and tenant_state.aggregate_id = grant_row.tenant_id
         left join access_runtime.lumen_projection_state operator_state
           on operator_state.projection_kind = 'operator_grant'
          and operator_state.tenant_id = grant_row.tenant_id
          and operator_state.aggregate_id = grant_row.operator_id
        where grant_row.product_id = $1
          and (
            tenant_state.tenant_id is null
            or tenant_state.source_updated_at < tenant.updated_at
            or operator_state.tenant_id is null
            or operator_state.source_updated_at < greatest(grant_row.updated_at, operator_row.updated_at)
          )
        order by grant_row.tenant_id, grant_row.operator_id
        limit $2`,
      [LUMEN_PRODUCT_ID, boundedLimit + 1]
    );
    const selected = candidates.rows.slice(0, boundedLimit);
    let eventsEnqueued = 0;
    for (const candidate of selected) {
      const result = await projector(transaction, candidate);
      eventsEnqueued += result.eventsEnqueued;
    }
    return {
      candidatesProcessed: selected.length,
      eventsEnqueued,
      hasMore: candidates.rows.length > boundedLimit
    };
  });
}

/** Serialized, lifecycle-safe periodic reconciliation for mutations missed by an immediate producer. */
export class AccessLumenProjectionReconciler {
  readonly #db: DatabaseClient;
  readonly #limit: number;
  readonly #intervalMs: number;
  readonly #reconcile: AccessLumenReconcile;
  #active: Promise<AccessLumenBackfillResult> | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #stopping = false;

  constructor(
    db: DatabaseClient,
    limit: number,
    intervalMs: number,
    reconcile: AccessLumenReconcile = backfillAccessLumenProjections
  ) {
    this.#db = db;
    this.#limit = normalizeBackfillLimit(limit);
    this.#intervalMs = normalizeReconcileInterval(intervalMs);
    this.#reconcile = reconcile;
  }

  get isRunning(): boolean {
    return this.#interval !== undefined;
  }

  reconcileOnce(): Promise<AccessLumenBackfillResult> {
    if (this.#stopping) return Promise.resolve(emptyBackfillResult());
    if (this.#active !== undefined) return this.#active;
    const active = Promise.resolve().then(() => this.#reconcile(this.#db, this.#limit));
    this.#active = active;
    void active.then(
      () => this.#release(active),
      () => this.#release(active)
    );
    return active;
  }

  start(onError: (error: unknown) => void = () => undefined): void {
    if (this.#interval !== undefined || this.#stopping) return;
    this.#interval = setInterval(() => {
      void this.reconcileOnce().catch(onError);
    }, this.#intervalMs);
    this.#interval.unref?.();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#interval !== undefined) {
      clearInterval(this.#interval);
      this.#interval = undefined;
    }
    try {
      await this.#active;
    } catch {
      // Reconciliation already reports through the runtime callback; shutdown
      // must only wait for it, never turn a recovered projection error into a hang.
    }
  }

  #release(active: Promise<AccessLumenBackfillResult>): void {
    if (this.#active === active) this.#active = undefined;
  }
}

export class PostgresAccessLumenProjectionOutbox {
  readonly #destination: string;

  constructor(
    private readonly db: DatabaseClient,
    private readonly workerId: string,
    lumenServiceUrl?: string
  ) {
    this.#destination = lumenServiceUrl
      ? `${normalizeHttpServiceUrl(lumenServiceUrl)}${LUMEN_PROJECTION_PATH}`
      : "nats://hyperion-events";
  }

  async claim(limit: number): Promise<AccessLumenOutboxDelivery[]> {
    const result = await this.db.query<ClaimedProjectionOutboxRow>(
      `with terminalized as (
         update access_runtime.lumen_projection_outbox
            set status = 'dead_letter', locked_at = null, locked_by = null,
                last_error_code = coalesce(last_error_code, 'lease_attempts_exhausted'), updated_at = now()
          where status = 'processing'
            and locked_at < now() - interval '2 minutes'
            and attempt_count >= max_attempts
       ), candidates as (
         select id
           from access_runtime.lumen_projection_outbox
          where (status in ('queued', 'retry_scheduled')
                 or (status = 'processing' and locked_at < now() - interval '2 minutes'))
            and next_attempt_at <= now()
            and attempt_count < max_attempts
          order by next_attempt_at, created_at, id
          for update skip locked
          limit $2
       )
       update access_runtime.lumen_projection_outbox event_row
          set status = 'processing',
              attempt_count = event_row.attempt_count + 1,
              locked_at = now(), locked_by = $1, updated_at = now()
         from candidates
        where event_row.id = candidates.id
       returning event_row.id,
                 event_row.tenant_id as "tenantId",
                 event_row.event_type as "eventType",
                 event_row.event_version as "eventVersion",
                 event_row.occurred_at as "occurredAt",
                 event_row.payload`,
      [this.workerId, Math.max(1, Math.min(DEFAULT_BATCH_SIZE, Math.trunc(limit)))]
    );

    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      type: row.eventType,
      version: row.eventVersion,
      occurredAt: toIsoDate(row.occurredAt, "outbox occurredAt"),
      payload: row.payload,
      destination: this.#destination
    }));
  }

  async complete(eventId: string): Promise<void> {
    await this.db.query(
      `update access_runtime.lumen_projection_outbox
          set status = 'published', published_at = now(),
              locked_at = null, locked_by = null, last_error_code = null, updated_at = now()
        where id = $1 and status = 'processing' and locked_by = $2`,
      [eventId, this.workerId]
    );
  }

  async fail(eventId: string, errorCode: HttpOutboxFailureCode | string): Promise<void> {
    await this.db.query(
      `update access_runtime.lumen_projection_outbox
          set status = case when attempt_count >= max_attempts then 'dead_letter' else 'retry_scheduled' end,
              next_attempt_at = case when attempt_count >= max_attempts then next_attempt_at
                else now() + make_interval(secs => least(300, power(2, least(attempt_count, 8))::integer)) end,
              locked_at = null, locked_by = null,
              last_error_code = $3, updated_at = now()
        where id = $1 and status = 'processing' and locked_by = $2`,
      [eventId, this.workerId, sanitizeErrorCode(errorCode)]
    );
  }

  /**
   * Requeues one exact terminal delivery while retaining its event id and
   * payload. The three-part selector prevents an operator from redriving a
   * different tenant or projection after copying an id from telemetry.
   */
  redriveDeadLetter(selection: AccessLumenDeadLetterSelection): Promise<AccessLumenDeadLetterRedrive | undefined> {
    return redriveAccessLumenProjectionDeadLetter(this.db, selection);
  }
}

export async function redriveAccessLumenProjectionDeadLetter(
  db: DatabaseClient,
  selection: AccessLumenDeadLetterSelection
): Promise<AccessLumenDeadLetterRedrive | undefined> {
  assertUuid(selection.eventId, "LUMEN projection event id");
  assertUuid(selection.tenantId, "LUMEN projection tenant id");
  if (selection.projectionKind !== "tenant_snapshot" && selection.projectionKind !== "operator_grant") {
    throw new Error("LUMEN projection kind must be tenant_snapshot or operator_grant");
  }

  const result = await db.query<{
    eventId: string;
    tenantId: string;
    projectionKind: AccessLumenProjectionKind;
    sourceVersion: string | number;
  }>(
    `update access_runtime.lumen_projection_outbox
        set status = 'queued', attempt_count = 0, next_attempt_at = now(),
            locked_at = null, locked_by = null, published_at = null,
            last_error_code = null, updated_at = now()
      where id = $1::uuid
        and tenant_id = $2::uuid
        and projection_kind = $3
        and status = 'dead_letter'
    returning id as "eventId", tenant_id as "tenantId",
              projection_kind as "projectionKind", source_version::text as "sourceVersion"`,
    [selection.eventId, selection.tenantId, selection.projectionKind]
  );
  const row = result.rows[0];
  return row
    ? {
        eventId: row.eventId,
        tenantId: row.tenantId,
        projectionKind: row.projectionKind,
        sourceVersion: String(row.sourceVersion)
      }
    : undefined;
}

/**
 * Requeues one exact current, already-published Access-owned LUMEN projection.
 * The existing outbox row is reused, so event id, aggregate, payload and both
 * provider/contract versions remain unchanged. A repeated request is a no-op
 * because the first request moves the row out of `published`.
 *
 * The delay is longer than the configured JetStream duplicate window. This
 * prevents the CLI from claiming a replay while the broker could still
 * suppress the same event id as a transport duplicate.
 */
export async function replayCurrentAccessLumenProjection(
  db: DatabaseClient,
  selection: AccessLumenReplaySelection
): Promise<AccessLumenReplayResult | undefined> {
  assertUuid(selection.eventId, "LUMEN projection event id");
  assertUuid(selection.tenantId, "LUMEN projection tenant id");
  if (selection.projectionKind !== "tenant_snapshot" && selection.projectionKind !== "operator_grant") {
    throw new Error("LUMEN projection kind must be tenant_snapshot or operator_grant");
  }

  const result = await db.query<{
    eventId: string;
    tenantId: string;
    projectionKind: AccessLumenProjectionKind;
    aggregateId: string;
    sourceVersion: string | number;
    eventType: string;
    eventVersion: number;
  }>(
    `update access_runtime.lumen_projection_outbox event_row
        set status = 'retry_scheduled', attempt_count = 0, next_attempt_at = now(),
            published_at = null, locked_at = null, locked_by = null,
            last_error_code = null, updated_at = now()
       from access_runtime.lumen_projection_state state_row
      where event_row.id = $1::uuid
        and event_row.tenant_id = $2::uuid
        and event_row.projection_kind = $3
        and state_row.projection_kind = event_row.projection_kind
        and state_row.tenant_id = event_row.tenant_id
        and state_row.aggregate_id = event_row.aggregate_id
        and state_row.source_version = event_row.source_version
        and event_row.source_version between 1 and 9007199254740991
        and event_row.event_version = 1
        and (
          (event_row.projection_kind = 'tenant_snapshot'
            and event_row.event_type = 'access.lumen.tenant-snapshot.v1')
          or
          (event_row.projection_kind = 'operator_grant'
            and event_row.event_type = 'access.lumen.operator-grant.v1')
        )
        and event_row.status = 'published'
        and event_row.published_at <= now() - interval '3 minutes'
      returning event_row.id as "eventId", event_row.tenant_id as "tenantId",
                event_row.projection_kind as "projectionKind",
                event_row.aggregate_id as "aggregateId",
                event_row.source_version::text as "sourceVersion",
                event_row.event_type as "eventType",
                event_row.event_version as "eventVersion"`,
    [selection.eventId, selection.tenantId, selection.projectionKind]
  );
  const row = result.rows[0];
  if (!row) return undefined;

  const expectedEventType =
    row.projectionKind === "tenant_snapshot" ? ACCESS_LUMEN_TENANT_SNAPSHOT_EVENT : ACCESS_LUMEN_OPERATOR_GRANT_EVENT;
  const sourceVersion = Number(row.sourceVersion);
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
    throw new Error("LUMEN projection replay has an invalid source version");
  }
  if (row.eventType !== expectedEventType || row.eventVersion !== 1) {
    throw new Error("LUMEN projection replay has an invalid event contract");
  }
  assertUuid(row.aggregateId, "LUMEN projection aggregate id");

  return {
    eventId: row.eventId,
    tenantId: row.tenantId,
    projectionKind: row.projectionKind,
    aggregateId: row.aggregateId,
    sourceVersion: String(row.sourceVersion),
    eventType: expectedEventType,
    eventVersion: 1
  };
}

export function createAccessLumenProjectionDispatcher(
  outbox: PostgresAccessLumenProjectionOutbox,
  workerId: string,
  internalToken: string,
  fetchImplementation: HttpOutboxFetch = globalThis.fetch
): HttpOutboxDispatcher<Record<string, unknown>> {
  return new HttpOutboxDispatcher<Record<string, unknown>>({
    workerId,
    internalToken,
    fetch: createAccessLumenWorkloadFetch(internalToken, fetchImplementation),
    claim: (limit) => outbox.claim(limit),
    complete: (eventId) => outbox.complete(eventId),
    fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
    batchSize: DEFAULT_BATCH_SIZE,
    intervalMs: 1_000,
    timeoutMs: 5_000
  });
}

export function createAccessLumenProjectionJetStreamDispatcher(
  outbox: PostgresAccessLumenProjectionOutbox,
  workerId: string,
  configuration: Extract<AccessLumenProjectionConfiguration, { transport: "jetstream" }>,
  sessionFactory?: JetStreamSessionFactory
): JetStreamOutboxDispatcher<Record<string, unknown>> {
  return new JetStreamOutboxDispatcher<Record<string, unknown>>({
    workerId,
    servers: configuration.natsUrl,
    ...configuration.authentication,
    connectionName: workerId,
    subjectPrefix: "hyperion.events",
    expectedStream: HYPERION_EVENTS_STREAM,
    claim: (limit) => outbox.claim(limit),
    complete: (eventId) => outbox.complete(eventId),
    fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
    batchSize: DEFAULT_BATCH_SIZE,
    intervalMs: 1_000,
    connectTimeoutMs: 5_000,
    publishTimeoutMs: 5_000,
    ...(sessionFactory === undefined ? {} : { sessionFactory })
  });
}

export function createAccessLumenWorkloadFetch(
  internalToken: string,
  fetchImplementation: HttpOutboxFetch = globalThis.fetch
): HttpOutboxFetch {
  const workloadHeaders = createInternalAuthorizationHeaders("identity-service", internalToken);
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(workloadHeaders)) headers.set(name, value);
    return fetchImplementation(input, { ...init, headers, redirect: "error" });
  };
}

export function readAccessLumenProjectionConfiguration(env: NodeJS.ProcessEnv): AccessLumenProjectionConfiguration {
  const transport = env.ACCESS_LUMEN_PROJECTION_TRANSPORT?.trim() || "disabled";
  if (transport === "disabled") return { transport };
  if (transport === "jetstream") {
    if (env.DURABLE_EVENT_TRANSPORT?.trim() !== "jetstream") {
      throw new Error("Access→LUMEN JetStream delivery requires DURABLE_EVENT_TRANSPORT=jetstream");
    }
    return {
      transport,
      natsUrl: requireCredentialFreeNatsUrl(env.NATS_URL),
      authentication: readNatsAuthentication(
        { authToken: env.NATS_AUTH_TOKEN, username: env.NATS_USERNAME, password: env.NATS_PASSWORD },
        {
          required: true,
          minimumSecretLength: 24,
          serverConfigurationSafe: true,
          allowToken: !isRestrictedDeploymentEnvironment(env)
        }
      )!,
      deliveryEnabled: env.DURABLE_OUTBOX_ENABLED !== "false",
      backfillLimit: readBackfillLimit(env.ACCESS_LUMEN_BACKFILL_LIMIT),
      reconcileIntervalMs: readReconcileInterval(env.ACCESS_LUMEN_RECONCILE_INTERVAL_MS)
    };
  }
  if (transport !== "http") {
    throw new Error("ACCESS_LUMEN_PROJECTION_TRANSPORT must be disabled or http");
  }
  if (env.DURABLE_EVENT_TRANSPORT?.trim() === "jetstream") {
    throw new Error(
      "Access→LUMEN HTTP delivery requires DURABLE_EVENT_TRANSPORT=http; select the JetStream projection transport in the overlay"
    );
  }

  const internalToken = readInternalCredential(env, "ACCESS_TO_LUMEN_TOKEN");
  if (!internalToken) throw new Error("ACCESS_TO_LUMEN_TOKEN is required for Access→LUMEN HTTP delivery");
  const serviceUrl = normalizeHttpServiceUrl(env.LUMEN_SERVICE_URL ?? "");
  return {
    transport,
    serviceUrl,
    internalToken,
    deliveryEnabled: env.DURABLE_OUTBOX_ENABLED !== "false" && env.DURABLE_HTTP_OUTBOX_ENABLED !== "false",
    backfillLimit: readBackfillLimit(env.ACCESS_LUMEN_BACKFILL_LIMIT),
    reconcileIntervalMs: readReconcileInterval(env.ACCESS_LUMEN_RECONCILE_INTERVAL_MS)
  };
}

async function writeProjection(transaction: DatabaseExecutor, write: ProjectionWrite): Promise<0 | 1> {
  const payloadHash = sha256CanonicalJson(write.payloadWithoutSource);
  await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `access:lumen:${write.kind}:${write.tenantId}:${write.aggregateId}`
  ]);
  const existingResult = await transaction.query<ProjectionStateRow>(
    `select source_version::text as "sourceVersion", payload_hash as "payloadHash"
       from access_runtime.lumen_projection_state
      where projection_kind = $1 and tenant_id = $2 and aggregate_id = $3
      for update`,
    [write.kind, write.tenantId, write.aggregateId]
  );
  const existing = existingResult.rows[0];
  if (existing?.payloadHash === payloadHash) {
    await transaction.query(
      `update access_runtime.lumen_projection_state
          set source_updated_at = greatest(source_updated_at, $4::timestamptz), updated_at = now()
        where projection_kind = $1 and tenant_id = $2 and aggregate_id = $3`,
      [write.kind, write.tenantId, write.aggregateId, write.sourceUpdatedAt]
    );
    return 0;
  }

  // The legacy LUMEN bootstrap used epoch-milliseconds as its source version.
  // Stay above both that timestamp watermark and our last provider sequence so
  // transitional seed/reconciliation jobs cannot make this stream look stale.
  const sourceVersion = existing
    ? Math.max(readNextSourceVersion(existing.sourceVersion), initialSourceVersion(write.sourceUpdatedAt))
    : initialSourceVersion(write.sourceUpdatedAt);
  const occurredAt = new Date().toISOString();
  const payload = {
    ...write.payloadWithoutSource,
    sourceVersion,
    sourceUpdatedAt: write.sourceUpdatedAt
  };
  await transaction.query(
    `insert into access_runtime.lumen_projection_outbox
       (id, tenant_id, projection_kind, aggregate_id, source_version,
        event_type, event_version, payload, occurred_at)
     values ($1, $2, $3, $4, $5, $6, 1, $7::jsonb, $8)`,
    [
      randomUUID(),
      write.tenantId,
      write.kind,
      write.aggregateId,
      sourceVersion,
      write.eventType,
      JSON.stringify(payload),
      occurredAt
    ]
  );

  // Persist the delivery intent before advancing the producer watermark. Both
  // writes remain in the caller-owned source transaction, so either later
  // watermark failure or an outbox failure rolls the source mutation back.
  if (existing) {
    await transaction.query(
      `update access_runtime.lumen_projection_state
          set source_version = $4, source_updated_at = $5, payload_hash = $6, updated_at = now()
        where projection_kind = $1 and tenant_id = $2 and aggregate_id = $3`,
      [write.kind, write.tenantId, write.aggregateId, sourceVersion, write.sourceUpdatedAt, payloadHash]
    );
  } else {
    await transaction.query(
      `insert into access_runtime.lumen_projection_state
         (projection_kind, tenant_id, aggregate_id, source_version, source_updated_at, payload_hash)
       values ($1, $2, $3, $4, $5, $6)`,
      [write.kind, write.tenantId, write.aggregateId, sourceVersion, write.sourceUpdatedAt, payloadHash]
    );
  }
  return 1;
}

function selectLumenRole(roles: readonly string[]): string {
  const sorted = [...roles].sort();
  for (const preferred of ["admin", "coordinator", "advisor", "auditor"]) {
    if (sorted.includes(preferred)) return preferred;
  }
  const role = sorted[0];
  if (!role) throw new Error("LUMEN projection grant has no role");
  return role;
}

function sha256CanonicalJson(value: Record<string, boolean | string>): string {
  const canonicalEntries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(canonicalEntries)))
    .digest("hex");
}

function readNextSourceVersion(value: string | number): number {
  const current = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(current) || current < 1 || current >= MAX_SOURCE_VERSION) {
    throw new Error("LUMEN projection source version is invalid or exhausted");
  }
  return current + 1;
}

function initialSourceVersion(sourceUpdatedAt: string): number {
  const legacyWatermark = Math.max(0, Math.floor(new Date(sourceUpdatedAt).getTime()));
  if (!Number.isSafeInteger(legacyWatermark) || legacyWatermark >= MAX_SOURCE_VERSION) {
    throw new Error("LUMEN projection source timestamp cannot seed a safe version");
  }
  return legacyWatermark + 1;
}

function toIsoDate(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${field} must be a UUID`);
  }
}

function normalizeBackfillLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BACKFILL_LIMIT) {
    throw new Error(`Access→LUMEN backfill limit must be between 1 and ${MAX_BACKFILL_LIMIT}`);
  }
  return limit;
}

function readBackfillLimit(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_BACKFILL_LIMIT;
  if (!/^\d+$/.test(value.trim())) throw new Error("ACCESS_LUMEN_BACKFILL_LIMIT must be a positive integer");
  return normalizeBackfillLimit(Number(value));
}

function normalizeReconcileInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_RECONCILE_INTERVAL_MS || value > MAX_RECONCILE_INTERVAL_MS) {
    throw new Error(
      `ACCESS_LUMEN_RECONCILE_INTERVAL_MS must be between ${MIN_RECONCILE_INTERVAL_MS} and ${MAX_RECONCILE_INTERVAL_MS}`
    );
  }
  return value;
}

function readReconcileInterval(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_RECONCILE_INTERVAL_MS;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("ACCESS_LUMEN_RECONCILE_INTERVAL_MS must be a positive integer");
  }
  return normalizeReconcileInterval(Number(value));
}

function emptyBackfillResult(): AccessLumenBackfillResult {
  return { candidatesProcessed: 0, eventsEnqueued: 0, hasMore: false };
}

function requireCredentialFreeNatsUrl(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error("NATS_URL is required for Access→LUMEN JetStream delivery");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("NATS_URL must be a valid credential-free URL");
  }
  if (
    (parsed.protocol !== "nats:" && parsed.protocol !== "tls:") ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname ||
    parsed.pathname !== "" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("NATS_URL must be a credential-free nats: or tls: endpoint");
  }
  return normalized;
}

function normalizeHttpServiceUrl(value: string): string {
  const normalized = value.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("LUMEN_SERVICE_URL must be a valid HTTP(S) service URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error("LUMEN_SERVICE_URL must be an HTTP(S) origin without credentials, path, query, or hash");
  }
  return normalized;
}

function sanitizeErrorCode(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 64) || "delivery_failed"
  );
}

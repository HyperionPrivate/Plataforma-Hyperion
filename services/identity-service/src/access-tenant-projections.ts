import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";
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
  accessTenantSnapshotEventSchema,
  accessTenantSnapshotPayloadSchema,
  accessTenantSnapshotV1EventType,
  type AccessTenantSnapshotPayload
} from "@hyperion/platform-contracts/access-tenant-snapshot";
import {
  createInternalAuthorizationHeaders,
  isRestrictedDeploymentEnvironment,
  readInternalCredential
} from "@hyperion/service-runtime";
import { createHash, randomUUID } from "node:crypto";

const MAX_SOURCE_VERSION = Number.MAX_SAFE_INTEGER;
const DEFAULT_RECONCILE_LIMIT = 100;
const MAX_RECONCILE_LIMIT = 1_000;
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const MIN_RECONCILE_INTERVAL_MS = 1_000;
const MAX_RECONCILE_INTERVAL_MS = 3_600_000;
const MAX_REENTRANT_PASSES = 10;
const DEFAULT_BATCH_SIZE = 20;
const HYPERION_EVENTS_STREAM = "HYPERION_EVENTS";
const PRIVATE_HTTP_HOSTS = new Set([
  "whatsapp-channel-service",
  "pulso-iris-service",
  "localhost",
  "127.0.0.1",
  "[::1]"
]);

interface TenantSourceRow {
  readonly tenantId: string;
  readonly status: AccessTenantSnapshotPayload["status"];
  readonly sourceUpdatedAt: Date | string;
  readonly sourceWatermark?: Date | string;
}

interface TenantCandidateRow {
  readonly tenantId: string;
}

interface ProjectionStateRow {
  readonly sourceVersion: string | number;
  readonly payloadHash: string;
}

interface ClaimedTenantOutboxRow {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceVersion: string | number;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly occurredAt: Date | string;
  readonly payload: unknown;
}

export interface AccessTenantProjectionResult {
  readonly eventsEnqueued: number;
}

export interface AccessTenantReconcileResult {
  readonly candidatesProcessed: number;
  readonly eventsEnqueued: number;
  readonly hasMore: boolean;
}

interface ReconcileConfiguration {
  readonly reconcileLimit: number;
  readonly reconcileIntervalMs: number;
}

export type AccessTenantProjectionConfiguration =
  | (ReconcileConfiguration & { readonly transport: "disabled" })
  | (ReconcileConfiguration & {
      readonly transport: "http";
      readonly destinations: readonly string[];
      readonly internalToken: string;
      readonly deliveryEnabled: boolean;
      readonly allowPrivateHttp: boolean;
    })
  | (ReconcileConfiguration & {
      readonly transport: "jetstream";
      readonly natsUrl: string;
      readonly authentication: NatsAuthentication;
      readonly deliveryEnabled: boolean;
    });

export interface AccessTenantOutboxDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly type: typeof accessTenantSnapshotV1EventType;
  readonly version: 1;
  readonly occurredAt: string;
  readonly payload: AccessTenantSnapshotPayload;
  readonly destination: readonly string[];
}

export interface AccessTenantDeadLetterSelection {
  readonly eventId: string;
  readonly tenantId: string;
}

export interface AccessTenantRedriveResult extends AccessTenantDeadLetterSelection {
  readonly sourceVersion: number;
  readonly eventType: typeof accessTenantSnapshotV1EventType;
}

export interface AccessTenantReplaySelection {
  readonly tenantId: string;
}

export interface AccessTenantReplayResult extends AccessTenantReplaySelection {
  readonly eventId: string;
  readonly sourceVersion: number;
  readonly eventType: typeof accessTenantSnapshotV1EventType;
}

export type AccessTenantReconcile = (db: DatabaseClient, limit: number) => Promise<AccessTenantReconcileResult>;

/**
 * Reconciles a bounded page of every customer tenant. Bootstrap/control tenants
 * are excluded by the Access-owned registry, never by slug or product grants.
 */
export async function reconcileAccessTenantSnapshots(
  db: DatabaseClient,
  limit = DEFAULT_RECONCILE_LIMIT
): Promise<AccessTenantReconcileResult> {
  const boundedLimit = normalizeReconcileLimit(limit);
  const candidates = await db.query<TenantCandidateRow>(
    `select tenant.id as "tenantId"
         from platform.tenants tenant
         left join access_runtime.tenant_projection_state projection
           on projection.tenant_id = tenant.id
        where not exists (
                select 1
                  from access_runtime.bootstrap_tenants bootstrap
                 where bootstrap.tenant_id = tenant.id
              )
          and (
            projection.tenant_id is null
            or projection.source_updated_at < tenant.updated_at
          )
        order by tenant.updated_at, tenant.id
        limit $1`,
    [boundedLimit + 1]
  );
  const selected = candidates.rows.slice(0, boundedLimit);
  let eventsEnqueued = 0;
  for (const tenant of selected) {
    const result = await db.transaction((transaction) => enqueueAccessTenantSnapshot(transaction, tenant.tenantId));
    eventsEnqueued += result.eventsEnqueued;
  }
  return {
    candidatesProcessed: selected.length,
    eventsEnqueued,
    hasMore: candidates.rows.length > boundedLimit
  };
}

/**
 * Writes the durable intent before advancing the provider watermark, inside the
 * caller transaction. A tenant-scoped advisory lock serializes competing
 * Identity instances without relying on a process-local mutex.
 */
export async function enqueueAccessTenantSnapshot(
  transaction: DatabaseExecutor,
  tenantId: string
): Promise<AccessTenantProjectionResult> {
  await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `access:tenant-snapshot:${tenantId}`
  ]);
  const sourceResult = await transaction.query<TenantSourceRow>(
    `select tenant.id as "tenantId", tenant.status,
            tenant.updated_at as "sourceUpdatedAt",
            tenant.updated_at::text as "sourceWatermark"
       from platform.tenants tenant
      where tenant.id = $1
        and not exists (
          select 1 from access_runtime.bootstrap_tenants bootstrap
           where bootstrap.tenant_id = tenant.id
        )`,
    [tenantId]
  );
  const source = sourceResult.rows[0];
  if (!source) return { eventsEnqueued: 0 };
  const sourceUpdatedAt = toIsoDate(source.sourceUpdatedAt, "tenant sourceUpdatedAt");
  const sourceWatermark = source.sourceWatermark ?? source.sourceUpdatedAt;
  toIsoDate(sourceWatermark, "tenant sourceWatermark");
  const payloadWithoutVersion = { tenantId: source.tenantId, status: source.status } as const;
  const payloadHash = sha256CanonicalJson(payloadWithoutVersion);

  const stateResult = await transaction.query<ProjectionStateRow>(
    `select source_version::text as "sourceVersion", payload_hash as "payloadHash"
       from access_runtime.tenant_projection_state
      where tenant_id = $1
      for update`,
    [tenantId]
  );
  const existing = stateResult.rows[0];
  if (existing?.payloadHash === payloadHash) {
    await transaction.query(
      `update access_runtime.tenant_projection_state
          set source_updated_at = greatest(source_updated_at, $2::timestamptz), updated_at = now()
        where tenant_id = $1`,
      [tenantId, sourceWatermark]
    );
    return { eventsEnqueued: 0 };
  }

  const sourceVersion = existing
    ? readNextSourceVersion(existing.sourceVersion)
    : initialSourceVersion(sourceUpdatedAt);
  const occurredAt = new Date().toISOString();
  const payload = accessTenantSnapshotPayloadSchema.parse({
    ...payloadWithoutVersion,
    sourceVersion,
    sourceUpdatedAt
  });
  const event = accessTenantSnapshotEventSchema.parse({
    id: randomUUID(),
    type: accessTenantSnapshotV1EventType,
    version: 1,
    occurredAt,
    tenantId: source.tenantId,
    payload
  });

  await transaction.query(
    `insert into access_runtime.tenant_projection_outbox
       (id, tenant_id, source_version, event_type, event_version, payload, occurred_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      event.id,
      event.tenantId,
      event.payload.sourceVersion,
      event.type,
      event.version,
      JSON.stringify(event.payload),
      event.occurredAt
    ]
  );

  if (existing) {
    await transaction.query(
      `update access_runtime.tenant_projection_state
          set source_version = $2, source_updated_at = $3, payload_hash = $4, updated_at = now()
        where tenant_id = $1`,
      [tenantId, sourceVersion, sourceWatermark, payloadHash]
    );
  } else {
    await transaction.query(
      `insert into access_runtime.tenant_projection_state
         (tenant_id, source_version, source_updated_at, payload_hash)
       values ($1, $2, $3, $4)`,
      [tenantId, sourceVersion, sourceWatermark, payloadHash]
    );
  }
  return { eventsEnqueued: 1 };
}

/**
 * A lifecycle-safe reconciler. Concurrent/reentrant calls share one serial run;
 * a page indicating more work is drained immediately, but never beyond the
 * fixed pass ceiling so startup and shutdown remain bounded.
 */
export class AccessTenantProjectionReconciler {
  readonly #db: DatabaseClient;
  readonly #limit: number;
  readonly #intervalMs: number;
  readonly #reconcile: AccessTenantReconcile;
  #active: Promise<AccessTenantReconcileResult> | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #rerunRequested = false;
  #stopping = false;

  constructor(
    db: DatabaseClient,
    limit: number,
    intervalMs: number,
    reconcile: AccessTenantReconcile = reconcileAccessTenantSnapshots
  ) {
    this.#db = db;
    this.#limit = normalizeReconcileLimit(limit);
    this.#intervalMs = normalizeReconcileInterval(intervalMs);
    this.#reconcile = reconcile;
  }

  get isRunning(): boolean {
    return this.#interval !== undefined;
  }

  reconcileOnce(): Promise<AccessTenantReconcileResult> {
    if (this.#stopping) return Promise.resolve(emptyReconcileResult());
    if (this.#active !== undefined) {
      this.#rerunRequested = true;
      return this.#active;
    }
    const active = this.#runSerial();
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
    this.#rerunRequested = false;
    if (this.#interval !== undefined) {
      clearInterval(this.#interval);
      this.#interval = undefined;
    }
    try {
      await this.#active;
    } catch {
      // Runtime callbacks own reconciliation telemetry; shutdown only waits.
    }
  }

  async #runSerial(): Promise<AccessTenantReconcileResult> {
    let aggregate = emptyReconcileResult();
    for (let pass = 0; pass < MAX_REENTRANT_PASSES && !this.#stopping; pass += 1) {
      this.#rerunRequested = false;
      const page = await this.#reconcile(this.#db, this.#limit);
      aggregate = {
        candidatesProcessed: aggregate.candidatesProcessed + page.candidatesProcessed,
        eventsEnqueued: aggregate.eventsEnqueued + page.eventsEnqueued,
        hasMore: page.hasMore
      };
      if (!page.hasMore && !this.#rerunRequested) return aggregate;
    }
    return { ...aggregate, hasMore: true };
  }

  #release(active: Promise<AccessTenantReconcileResult>): void {
    if (this.#active === active) this.#active = undefined;
  }
}

export class PostgresAccessTenantProjectionOutbox {
  readonly #destinations: readonly string[];

  constructor(
    private readonly db: DatabaseClient,
    private readonly workerId: string,
    httpDestinations?: string | readonly string[],
    allowPrivateHttp = false
  ) {
    this.#destinations = httpDestinations
      ? normalizeHttpDestinations(httpDestinations, allowPrivateHttp)
      : ["nats://hyperion-events"];
  }

  async claim(limit: number): Promise<AccessTenantOutboxDelivery[]> {
    const result = await this.db.query<ClaimedTenantOutboxRow>(
      `with terminalized as (
         update access_runtime.tenant_projection_outbox
            set status = 'dead_letter', locked_at = null, locked_by = null,
                last_error_code = coalesce(last_error_code, 'lease_attempts_exhausted'), updated_at = now()
          where status = 'processing'
            and locked_at < now() - interval '2 minutes'
            and attempt_count >= max_attempts
       ), candidates as (
         select id
           from access_runtime.tenant_projection_outbox
          where (status in ('queued', 'retry_scheduled')
                 or (status = 'processing' and locked_at < now() - interval '2 minutes'))
            and next_attempt_at <= now()
            and attempt_count < max_attempts
          order by next_attempt_at, created_at, id
          for update skip locked
          limit $2
       )
       update access_runtime.tenant_projection_outbox event_row
          set status = 'processing', attempt_count = event_row.attempt_count + 1,
              locked_at = now(), locked_by = $1, updated_at = now()
         from candidates
        where event_row.id = candidates.id
       returning event_row.id, event_row.tenant_id as "tenantId",
                 event_row.source_version::text as "sourceVersion",
                 event_row.event_type as "eventType", event_row.event_version as "eventVersion",
                 event_row.occurred_at as "occurredAt", event_row.payload`,
      [this.workerId, Math.max(1, Math.min(DEFAULT_BATCH_SIZE, Math.trunc(limit)))]
    );

    return result.rows.map((row) => {
      const event = accessTenantSnapshotEventSchema.parse({
        id: row.id,
        type: row.eventType,
        version: row.eventVersion,
        occurredAt: toIsoDate(row.occurredAt, "outbox occurredAt"),
        tenantId: row.tenantId,
        payload: row.payload
      });
      if (event.payload.sourceVersion !== Number(row.sourceVersion)) {
        throw new Error("Access tenant outbox source version drifted");
      }
      return { ...event, destination: this.#destinations };
    });
  }

  async complete(eventId: string): Promise<void> {
    await this.db.query(
      `update access_runtime.tenant_projection_outbox
          set status = 'published', published_at = now(), locked_at = null,
              locked_by = null, last_error_code = null, updated_at = now()
        where id = $1 and status = 'processing' and locked_by = $2`,
      [eventId, this.workerId]
    );
  }

  async fail(eventId: string, errorCode: HttpOutboxFailureCode | string): Promise<void> {
    await this.db.query(
      `update access_runtime.tenant_projection_outbox
          set status = case when attempt_count >= max_attempts then 'dead_letter' else 'retry_scheduled' end,
              next_attempt_at = case when attempt_count >= max_attempts then next_attempt_at
                else now() + make_interval(secs => least(300, power(2, least(attempt_count, 8))::integer)) end,
              locked_at = null, locked_by = null, last_error_code = $3, updated_at = now()
        where id = $1 and status = 'processing' and locked_by = $2`,
      [eventId, this.workerId, sanitizeErrorCode(errorCode)]
    );
  }
}

/**
 * Requeues exactly one terminal delivery without regenerating its event id,
 * payload or provider watermark. The tenant selector prevents an operator from
 * copying an event id between customer contexts.
 */
export async function redriveAccessTenantProjectionDeadLetter(
  db: DatabaseClient,
  selection: AccessTenantDeadLetterSelection
): Promise<AccessTenantRedriveResult | undefined> {
  const result = await db.query<{
    eventId: string;
    tenantId: string;
    sourceVersion: string | number;
    eventType: string;
  }>(
    `update access_runtime.tenant_projection_outbox
        set status = 'retry_scheduled', attempt_count = 0, next_attempt_at = now(),
            locked_at = null, locked_by = null, last_error_code = null, updated_at = now()
      where id = $1 and tenant_id = $2 and status = 'dead_letter'
      returning id as "eventId", tenant_id as "tenantId",
                source_version::text as "sourceVersion", event_type as "eventType"`,
    [selection.eventId, selection.tenantId]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const sourceVersion = Number(row.sourceVersion);
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
    throw new Error("Access tenant projection dead letter has an invalid source version");
  }
  if (row.eventType !== accessTenantSnapshotV1EventType) {
    throw new Error("Access tenant projection dead letter has an invalid event type");
  }
  return {
    eventId: row.eventId,
    tenantId: row.tenantId,
    sourceVersion,
    eventType: accessTenantSnapshotV1EventType
  };
}

/**
 * Requeues the current, already-published snapshot for one exact tenant. The
 * event identity and payload are preserved so a restored Channel database can
 * be rebuilt without manufacturing a new provider version. The delay is
 * longer than the configured JetStream duplicate window; an earlier request
 * fails closed instead of reporting a replay the broker may suppress.
 */
export async function replayCurrentAccessTenantProjection(
  db: DatabaseClient,
  selection: AccessTenantReplaySelection
): Promise<AccessTenantReplayResult | undefined> {
  const result = await db.query<{
    eventId: string;
    tenantId: string;
    sourceVersion: string | number;
    eventType: string;
  }>(
    `update access_runtime.tenant_projection_outbox event_row
        set status = 'retry_scheduled', attempt_count = 0, next_attempt_at = now(),
            published_at = null, locked_at = null, locked_by = null,
            last_error_code = null, updated_at = now()
       from access_runtime.tenant_projection_state state_row
      where event_row.tenant_id = $1
        and state_row.tenant_id = event_row.tenant_id
        and state_row.source_version = event_row.source_version
        and event_row.status = 'published'
        and event_row.published_at <= now() - interval '3 minutes'
      returning event_row.id as "eventId", event_row.tenant_id as "tenantId",
                event_row.source_version::text as "sourceVersion",
                event_row.event_type as "eventType"`,
    [selection.tenantId]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const sourceVersion = Number(row.sourceVersion);
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
    throw new Error("Access tenant projection replay has an invalid source version");
  }
  if (row.eventType !== accessTenantSnapshotV1EventType) {
    throw new Error("Access tenant projection replay has an invalid event type");
  }
  return {
    eventId: row.eventId,
    tenantId: row.tenantId,
    sourceVersion,
    eventType: accessTenantSnapshotV1EventType
  };
}

export function createAccessTenantProjectionHttpDispatcher(
  outbox: PostgresAccessTenantProjectionOutbox,
  workerId: string,
  internalToken: string,
  fetchImplementation: HttpOutboxFetch = globalThis.fetch
): HttpOutboxDispatcher<AccessTenantSnapshotPayload> {
  return new HttpOutboxDispatcher<AccessTenantSnapshotPayload>({
    workerId,
    internalToken,
    fetch: createAccessTenantWorkloadFetch(internalToken, fetchImplementation),
    claim: (limit) => outbox.claim(limit),
    complete: (eventId) => outbox.complete(eventId),
    fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
    batchSize: DEFAULT_BATCH_SIZE,
    intervalMs: 1_000,
    timeoutMs: 5_000
  });
}

export function createAccessTenantProjectionJetStreamDispatcher(
  outbox: PostgresAccessTenantProjectionOutbox,
  workerId: string,
  configuration: Extract<AccessTenantProjectionConfiguration, { transport: "jetstream" }>,
  sessionFactory?: JetStreamSessionFactory
): JetStreamOutboxDispatcher<AccessTenantSnapshotPayload> {
  return new JetStreamOutboxDispatcher<AccessTenantSnapshotPayload>({
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

export function createAccessTenantWorkloadFetch(
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

export function readAccessTenantProjectionConfiguration(env: NodeJS.ProcessEnv): AccessTenantProjectionConfiguration {
  const reconcileLimit = readReconcileLimit(env.ACCESS_TENANT_SNAPSHOT_RECONCILE_LIMIT);
  const reconcileIntervalMs = readReconcileInterval(env.ACCESS_TENANT_SNAPSHOT_RECONCILE_INTERVAL_MS);
  const transport = env.ACCESS_TENANT_SNAPSHOT_TRANSPORT?.trim() || "disabled";
  if (transport === "disabled") return { transport, reconcileLimit, reconcileIntervalMs };

  if (transport === "jetstream") {
    if (env.DURABLE_EVENT_TRANSPORT?.trim() !== "jetstream") {
      throw new Error("Access tenant snapshot JetStream delivery requires DURABLE_EVENT_TRANSPORT=jetstream");
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
      reconcileLimit,
      reconcileIntervalMs
    };
  }

  if (transport !== "http") {
    throw new Error("ACCESS_TENANT_SNAPSHOT_TRANSPORT must be disabled, http, or jetstream");
  }
  if (env.DURABLE_EVENT_TRANSPORT?.trim() === "jetstream") {
    throw new Error("Access tenant snapshot HTTP delivery requires DURABLE_EVENT_TRANSPORT=http");
  }
  const internalToken = readInternalCredential(env, "ACCESS_TENANT_SNAPSHOT_HTTP_TOKEN");
  if (!internalToken) throw new Error("ACCESS_TENANT_SNAPSHOT_HTTP_TOKEN is required for HTTP delivery");
  const allowPrivateHttp = readPrivateHttpOptIn(env);
  return {
    transport,
    destinations: normalizeHttpDestinations(env.ACCESS_TENANT_SNAPSHOT_HTTP_URL ?? "", allowPrivateHttp),
    internalToken,
    deliveryEnabled: env.DURABLE_OUTBOX_ENABLED !== "false" && env.DURABLE_HTTP_OUTBOX_ENABLED !== "false",
    allowPrivateHttp,
    reconcileLimit,
    reconcileIntervalMs
  };
}

function readNextSourceVersion(value: string | number): number {
  const current = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(current) || current < 1 || current >= MAX_SOURCE_VERSION) {
    throw new Error("Access tenant snapshot source version is invalid or exhausted");
  }
  return current + 1;
}

function initialSourceVersion(sourceUpdatedAt: string): number {
  const watermark = Math.max(0, Math.floor(new Date(sourceUpdatedAt).getTime()));
  if (!Number.isSafeInteger(watermark) || watermark >= MAX_SOURCE_VERSION) {
    throw new Error("Access tenant source timestamp cannot seed a safe version");
  }
  return watermark + 1;
}

function sha256CanonicalJson(value: Readonly<Record<string, string>>): string {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(entries)))
    .digest("hex");
}

function toIsoDate(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function normalizeReconcileLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECONCILE_LIMIT) {
    throw new Error(`Access tenant snapshot reconcile limit must be between 1 and ${MAX_RECONCILE_LIMIT}`);
  }
  return limit;
}

function readReconcileLimit(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_RECONCILE_LIMIT;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("ACCESS_TENANT_SNAPSHOT_RECONCILE_LIMIT must be a positive integer");
  }
  return normalizeReconcileLimit(Number(value));
}

function normalizeReconcileInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_RECONCILE_INTERVAL_MS || value > MAX_RECONCILE_INTERVAL_MS) {
    throw new Error(
      `ACCESS_TENANT_SNAPSHOT_RECONCILE_INTERVAL_MS must be between ${MIN_RECONCILE_INTERVAL_MS} and ${MAX_RECONCILE_INTERVAL_MS}`
    );
  }
  return value;
}

function readReconcileInterval(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_RECONCILE_INTERVAL_MS;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("ACCESS_TENANT_SNAPSHOT_RECONCILE_INTERVAL_MS must be a positive integer");
  }
  return normalizeReconcileInterval(Number(value));
}

function emptyReconcileResult(): AccessTenantReconcileResult {
  return { candidatesProcessed: 0, eventsEnqueued: 0, hasMore: false };
}

function requireCredentialFreeNatsUrl(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error("NATS_URL is required for Access tenant snapshot JetStream delivery");
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
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("NATS_URL must be a credential-free nats: or tls: endpoint");
  }
  return normalized;
}

function readPrivateHttpOptIn(env: NodeJS.ProcessEnv): boolean {
  const value = env.ACCESS_TENANT_SNAPSHOT_ALLOW_PRIVATE_HTTP?.trim().toLowerCase();
  if (value !== undefined && value !== "" && value !== "true" && value !== "false") {
    throw new Error("ACCESS_TENANT_SNAPSHOT_ALLOW_PRIVATE_HTTP must be true or false");
  }
  const enabled = value === "true";
  if (enabled && isRestrictedDeploymentEnvironment(env)) {
    throw new Error("ACCESS_TENANT_SNAPSHOT_ALLOW_PRIVATE_HTTP is forbidden in staging and production");
  }
  return enabled;
}

function normalizeHttpDestinations(value: string | readonly string[], allowPrivateHttp: boolean): readonly string[] {
  const rawEntries =
    typeof value === "string"
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : value.map((entry) => entry.trim()).filter(Boolean);
  if (rawEntries.length === 0) {
    throw new Error("ACCESS_TENANT_SNAPSHOT_HTTP_URL must list one or more HTTP(S) endpoints");
  }
  const destinations: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawEntries) {
    const normalized = normalizeHttpDestination(entry, allowPrivateHttp);
    if (seen.has(normalized)) {
      throw new Error("ACCESS_TENANT_SNAPSHOT_HTTP_URL must not list duplicate destinations");
    }
    seen.add(normalized);
    destinations.push(normalized);
  }
  return destinations;
}

function normalizeHttpDestination(value: string, allowPrivateHttp: boolean): string {
  const normalized = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("ACCESS_TENANT_SNAPSHOT_HTTP_URL must be a valid HTTP(S) URL");
  }
  const permittedPrivateHttp =
    allowPrivateHttp && parsed.protocol === "http:" && PRIVATE_HTTP_HOSTS.has(parsed.hostname.toLowerCase());
  if (
    (parsed.protocol !== "https:" && !permittedPrivateHttp) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname === "/"
  ) {
    throw new Error(
      "ACCESS_TENANT_SNAPSHOT_HTTP_URL must be an exact HTTPS endpoint without credentials, query, or hash; " +
        "known private HTTP hosts require the explicit local/CI opt-in"
    );
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

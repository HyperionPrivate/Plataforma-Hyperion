import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";

export interface VoiceOutboxDelivery {
  id: string;
  tenantId: string | null;
  correlationId: string;
  type: string;
  version: number;
  occurredAt: string;
  payload: Record<string, unknown>;
  destination: string;
}

interface ClaimedVoiceOutboxRow {
  eventId: string;
  tenantId: string | null;
  correlationId: string;
  eventType: string;
  payload: Record<string, unknown>;
  destination: string;
  createdAt: Date;
}

export interface VoiceOutboxInsert {
  eventId: string;
  eventType: string;
  tenantId: string;
  correlationId: string;
  businessIdempotencyKey?: string;
  dataClassification?: "public" | "internal" | "confidential" | "restricted";
  payload: Record<string, unknown>;
  destination: string;
}

export class PostgresVoiceOutbox {
  constructor(
    private readonly db: DatabaseClient,
    private readonly workerId: string
  ) {}

  async claim(limit: number): Promise<VoiceOutboxDelivery[]> {
    const result = await this.db.query<ClaimedVoiceOutboxRow>(
      `with candidates as (
         select event_id
         from voice.outbox_events
         where (status = 'pending' and available_at <= now())
            or (status = 'dispatching' and locked_at < now() - interval '2 minutes')
         order by available_at, created_at
         for update skip locked
         limit $2
       )
       update voice.outbox_events event
       set status = 'dispatching',
           attempt_count = event.attempt_count + 1,
           locked_by = $1,
           locked_at = now(),
           updated_at = now()
       from candidates
       where event.event_id = candidates.event_id
       returning event.event_id as "eventId",
                 event.tenant_id as "tenantId",
                 event.correlation_id as "correlationId",
                 event.event_type as "eventType",
                 event.payload,
                 event.destination,
                 event.created_at as "createdAt"`,
      [this.workerId, Math.max(1, Math.min(20, Math.trunc(limit)))]
    );

    return result.rows.map((row) => ({
      id: row.eventId,
      tenantId: row.tenantId,
      correlationId: row.correlationId,
      type: row.eventType,
      version: 1,
      occurredAt: row.createdAt.toISOString(),
      payload: row.payload,
      destination: row.destination
    }));
  }

  async complete(eventId: string): Promise<void> {
    await this.db.query(
      `update voice.outbox_events
       set status = 'completed', locked_at = null, locked_by = null, last_error = null, updated_at = now()
       where event_id = $1 and status = 'dispatching' and locked_by = $2`,
      [eventId, this.workerId]
    );
  }

  async fail(eventId: string, errorCode: string): Promise<void> {
    await this.db.query(
      `with updated as (
         update voice.outbox_events
         set status = case when attempt_count >= 8 then 'failed' else 'pending' end,
             available_at = case
               when attempt_count >= 8 then available_at
               else now() + make_interval(secs => least(300, power(2, least(attempt_count, 8))::integer))
             end,
             locked_at = null,
             locked_by = null,
             last_error = $3,
             updated_at = now()
         where event_id = $1 and status = 'dispatching' and locked_by = $2
         returning event_id, event_type, tenant_id, payload, destination, last_error, status
       )
       insert into voice.outbox_dlq (
         event_id, event_type, tenant_id, payload, destination, last_error, failed_at, redriven_at
       )
       select event_id, event_type, tenant_id, payload, destination, last_error, now(), null
       from updated
       where status = 'failed'
       on conflict (event_id) do update
       set event_type = excluded.event_type,
           tenant_id = excluded.tenant_id,
           payload = excluded.payload,
           destination = excluded.destination,
           last_error = excluded.last_error,
           failed_at = excluded.failed_at,
           redriven_at = null`,
      [eventId, this.workerId, sanitizeErrorCode(errorCode)]
    );
  }
}

export interface VoiceOutboxDlqRow {
  eventId: string;
  eventType: string;
  tenantId: string | null;
  payload: Record<string, unknown>;
  destination: string;
  lastError: string | null;
  failedAt: Date;
  redrivenAt: Date | null;
}

export async function listVoiceOutboxDlq(
  db: DatabaseExecutor,
  tenantId: string,
  options: { pendingOnly?: boolean; limit?: number } = {}
): Promise<VoiceOutboxDlqRow[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
  const result = await db.query<VoiceOutboxDlqRow>(
    `select event_id as "eventId",
            event_type as "eventType",
            tenant_id as "tenantId",
            payload,
            destination,
            last_error as "lastError",
            failed_at as "failedAt",
            redriven_at as "redrivenAt"
     from voice.outbox_dlq
     where tenant_id = $1
       and ($2::boolean = false or redriven_at is null)
     order by failed_at desc
     limit $3`,
    [tenantId, options.pendingOnly === true, limit]
  );
  return result.rows;
}

export async function redriveVoiceOutboxDlq(db: DatabaseClient, tenantId: string, eventId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const dlq = await tx.query<{ eventId: string }>(
      `update voice.outbox_dlq
       set redriven_at = now()
       where event_id = $1 and tenant_id = $2
       returning event_id as "eventId"`,
      [eventId, tenantId]
    );
    if (dlq.rowCount === 0) return false;

    await tx.query(
      `update voice.outbox_events
       set status = 'pending',
           available_at = now(),
           locked_at = null,
           locked_by = null,
           last_error = null,
           updated_at = now()
       where event_id = $1`,
      [eventId]
    );
    return true;
  });
}

export async function insertVoiceOutboxEvent(db: DatabaseExecutor, event: VoiceOutboxInsert): Promise<void> {
  await db.query(
    `insert into voice.outbox_events (
       event_id, event_type, tenant_id, correlation_id, business_idempotency_key,
       data_classification, payload, destination, status
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'pending')`,
    [
      event.eventId,
      event.eventType,
      event.tenantId,
      event.correlationId,
      event.businessIdempotencyKey ?? null,
      event.dataClassification ?? "internal",
      JSON.stringify(event.payload),
      event.destination
    ]
  );
}

function sanitizeErrorCode(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 64) || "delivery_failed"
  );
}

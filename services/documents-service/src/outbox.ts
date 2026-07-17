import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";

export interface DocumentsOutboxDelivery {
  id: string;
  tenantId: string | null;
  type: string;
  version: number;
  occurredAt: string;
  payload: Record<string, unknown>;
  destination: string;
}

interface ClaimedDocumentsOutboxRow {
  eventId: string;
  tenantId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  destination: string;
  createdAt: Date;
}

export interface DocumentsOutboxInsert {
  eventId: string;
  eventType: string;
  tenantId: string;
  correlationId: string;
  businessIdempotencyKey?: string;
  dataClassification?: "public" | "internal" | "confidential" | "restricted";
  payload: Record<string, unknown>;
  destination: string;
}

export class PostgresDocumentsOutbox {
  constructor(
    private readonly db: DatabaseClient,
    private readonly workerId: string
  ) {}

  async claim(limit: number): Promise<DocumentsOutboxDelivery[]> {
    const result = await this.db.query<ClaimedDocumentsOutboxRow>(
      `with candidates as (
         select event_id
         from documents.outbox_events
         where status = 'pending'
           and available_at <= now()
           and (locked_at is null or locked_at < now() - interval '2 minutes')
         order by available_at, created_at
         for update skip locked
         limit $2
       )
       update documents.outbox_events event
       set status = 'dispatching',
           attempt_count = event.attempt_count + 1,
           locked_by = $1,
           locked_at = now(),
           updated_at = now()
       from candidates
       where event.event_id = candidates.event_id
       returning event.event_id as "eventId",
                 event.tenant_id as "tenantId",
                 event.event_type as "eventType",
                 event.payload,
                 event.destination,
                 event.created_at as "createdAt"`,
      [this.workerId, Math.max(1, Math.min(20, Math.trunc(limit)))]
    );

    return result.rows.map((row) => ({
      id: row.eventId,
      tenantId: row.tenantId,
      type: row.eventType,
      version: 1,
      occurredAt: row.createdAt.toISOString(),
      payload: row.payload,
      destination: row.destination
    }));
  }

  async complete(eventId: string): Promise<void> {
    await this.db.query(
      `update documents.outbox_events
       set status = 'completed', locked_at = null, locked_by = null, last_error = null, updated_at = now()
       where event_id = $1 and status = 'dispatching' and locked_by = $2`,
      [eventId, this.workerId]
    );
  }

  async fail(eventId: string, errorCode: string): Promise<void> {
    await this.db.query(
      `with updated as (
         update documents.outbox_events
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
       insert into documents.outbox_dlq (
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

export async function insertDocumentsOutboxEvent(db: DatabaseExecutor, event: DocumentsOutboxInsert): Promise<void> {
  await db.query(
    `insert into documents.outbox_events (
       event_id, event_type, tenant_id, correlation_id, business_idempotency_key,
       data_classification, payload, destination, status
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'pending')`,
    [
      event.eventId,
      event.eventType,
      event.tenantId,
      event.correlationId,
      event.businessIdempotencyKey ?? null,
      event.dataClassification ?? "confidential",
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

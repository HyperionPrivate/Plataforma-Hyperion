import type { DatabaseClient } from "@hyperion/database";

export const CHANNEL_AUDIT_EVENT_TYPE = "channel.audit.event.record.v1" as const;

export interface ChannelAuditOutboxDelivery {
  id: string;
  tenantId: string;
  type: string;
  version: number;
  occurredAt: string;
  payload: Record<string, unknown>;
  destination: string;
}

interface ClaimedOutboxRow {
  id: string;
  tenantId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

export class PostgresChannelAuditOutbox {
  private readonly destination: string;

  constructor(
    private readonly db: DatabaseClient,
    private readonly workerId: string,
    auditUrl: string
  ) {
    this.destination = `${auditUrl.replace(/\/$/, "")}/internal/v1/events`;
  }

  async claim(limit: number): Promise<ChannelAuditOutboxDelivery[]> {
    const result = await this.db.query<ClaimedOutboxRow>(
      `with terminalized as (
         update channel_runtime.outbox_events
         set status = 'dead_letter', locked_at = null, locked_by = null,
             last_error_code = coalesce(last_error_code, 'lease_attempts_exhausted'), updated_at = now()
         where status = 'processing' and locked_at < now() - interval '2 minutes'
           and attempt_count >= max_attempts
           and event_type = $3
       ), candidates as (
         select id from channel_runtime.outbox_events
         where (status in ('queued', 'retry_scheduled')
                or (status = 'processing' and locked_at < now() - interval '2 minutes'))
           and event_type = $3
           and next_attempt_at <= now() and attempt_count < max_attempts
         order by next_attempt_at, created_at for update skip locked limit $2
       )
       update channel_runtime.outbox_events event
       set status = 'processing', attempt_count = event.attempt_count + 1,
           locked_at = now(), locked_by = $1, updated_at = now()
       from candidates where event.id = candidates.id
       returning event.id, event.tenant_id as "tenantId", event.event_type as "eventType",
                 event.event_version as "eventVersion", event.occurred_at as "occurredAt", event.payload`,
      [this.workerId, Math.max(1, Math.min(20, Math.trunc(limit))), CHANNEL_AUDIT_EVENT_TYPE]
    );

    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      type: row.eventType,
      version: row.eventVersion,
      occurredAt: row.occurredAt.toISOString(),
      payload: row.payload,
      destination: this.destination
    }));
  }

  async complete(eventId: string): Promise<void> {
    await this.db.query(
      `update channel_runtime.outbox_events
       set status = 'published', published_at = now(), locked_at = null, locked_by = null,
           last_error_code = null, updated_at = now()
       where id = $1 and status = 'processing' and locked_by = $2 and event_type = $3`,
      [eventId, this.workerId, CHANNEL_AUDIT_EVENT_TYPE]
    );
  }

  async fail(eventId: string, errorCode: string): Promise<void> {
    await this.db.query(
      `update channel_runtime.outbox_events
       set status = case when attempt_count >= max_attempts then 'dead_letter' else 'retry_scheduled' end,
           next_attempt_at = case when attempt_count >= max_attempts then next_attempt_at
             else now() + make_interval(secs => least(300, power(2, least(attempt_count, 8))::integer)) end,
           locked_at = null, locked_by = null, last_error_code = $3, updated_at = now()
       where id = $1 and status = 'processing' and locked_by = $2 and event_type = $4`,
      [eventId, this.workerId, sanitizeErrorCode(errorCode), CHANNEL_AUDIT_EVENT_TYPE]
    );
  }
}

function sanitizeErrorCode(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 64) || "delivery_failed"
  );
}

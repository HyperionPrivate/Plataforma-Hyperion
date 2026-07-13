import type { DatabaseClient } from "@hyperion/database";

export interface ChannelOutboxDelivery {
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

interface OutboxLifecycleRow {
  id: string;
  tenantId: string;
  aggregateId: string;
  aggregateType: string;
  status: "published" | "retry_scheduled" | "dead_letter";
}

export class PostgresChannelOutbox {
  private readonly destination: string;

  constructor(
    private readonly db: DatabaseClient,
    private readonly workerId: string,
    pulsoIrisUrl: string
  ) {
    this.destination = `${pulsoIrisUrl.replace(/\/$/, "")}/internal/v1/events/channel-inbound`;
  }

  async claim(limit: number): Promise<ChannelOutboxDelivery[]> {
    const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
    const result = await this.db.query<ClaimedOutboxRow>(
      `with terminalized as (
         update channel_runtime.outbox_events event
         set status = 'dead_letter', locked_at = null, locked_by = null,
             last_error_code = coalesce(event.last_error_code, 'lease_attempts_exhausted'), updated_at = now()
         where status = 'processing'
           and locked_at < now() - interval '2 minutes'
           and attempt_count >= max_attempts
         returning event.id, event.tenant_id, event.aggregate_id, event.aggregate_type,
                   event.last_error_code
       ), terminalized_sources as (
         update channel_runtime.inbound_events source
         set status = case
               when source.status in ('processed', 'ignored') then source.status
               else 'dead_letter'
             end,
             locked_at = null, locked_by = null,
             last_error_code = case
               when source.status in ('processed', 'ignored') then source.last_error_code
               else event.last_error_code
             end,
             last_error_message = null,
             metadata = source.metadata || jsonb_build_object(
               'outboxStatus', 'dead_letter',
               'outboxEventId', event.id::text,
               'outboxErrorCode', event.last_error_code
             ),
             updated_at = now()
         from terminalized event
         where event.aggregate_type = 'channel_inbound_event'
           and source.tenant_id = event.tenant_id
           and source.id = event.aggregate_id
       ), candidates as (
         select id
         from channel_runtime.outbox_events
         where (
             status in ('queued', 'retry_scheduled')
             or (status = 'processing' and locked_at < now() - interval '2 minutes')
           )
           and next_attempt_at <= now()
           and attempt_count < max_attempts
         order by next_attempt_at, created_at
         for update skip locked
         limit $2
       )
       update channel_runtime.outbox_events event
       set status = 'processing', attempt_count = event.attempt_count + 1,
           locked_at = now(), locked_by = $1, updated_at = now()
       from candidates
       where event.id = candidates.id
       returning event.id, event.tenant_id as "tenantId", event.event_type as "eventType",
                 event.event_version as "eventVersion", event.occurred_at as "occurredAt", event.payload`,
      [this.workerId, boundedLimit]
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
    await this.db.transaction(async (client) => {
      const published = await client.query<OutboxLifecycleRow>(
        `update channel_runtime.outbox_events event
         set status = 'published', published_at = now(), locked_at = null, locked_by = null,
             last_error_code = null, updated_at = now()
         where event.id = $1 and event.status = 'processing' and event.locked_by = $2
         returning event.id, event.tenant_id as "tenantId", event.aggregate_id as "aggregateId",
                   event.aggregate_type as "aggregateType", event.status`,
        [eventId, this.workerId]
      );
      const event = published.rows[0];
      if (!event || event.aggregateType !== "channel_inbound_event") return;

      const source = await client.query<{ id: string }>(
        `update channel_runtime.inbound_events
         set status = 'processed', processed_at = coalesce(processed_at, now()),
             locked_at = null, locked_by = null, last_error_code = null,
             last_error_message = null,
             metadata = metadata || jsonb_build_object(
               'outboxStatus', 'published', 'outboxEventId', $3::text
             ),
             updated_at = now()
         where tenant_id = $1 and id = $2
         returning id`,
        [event.tenantId, event.aggregateId, event.id]
      );
      if ((source.rowCount ?? 0) !== 1) {
        throw new Error("Channel inbound source missing for published outbox event");
      }
    });
  }

  async fail(eventId: string, errorCode: string): Promise<void> {
    const sanitizedErrorCode = sanitizeErrorCode(errorCode);
    await this.db.transaction(async (client) => {
      const failed = await client.query<OutboxLifecycleRow>(
        `update channel_runtime.outbox_events event
         set status = case when event.attempt_count >= event.max_attempts then 'dead_letter' else 'retry_scheduled' end,
             next_attempt_at = case
               when event.attempt_count >= event.max_attempts then event.next_attempt_at
               else now() + make_interval(secs => least(300, power(2, least(event.attempt_count, 8))::integer))
             end,
             locked_at = null, locked_by = null, last_error_code = $3, updated_at = now()
         where event.id = $1 and event.status = 'processing' and event.locked_by = $2
         returning event.id, event.tenant_id as "tenantId", event.aggregate_id as "aggregateId",
                   event.aggregate_type as "aggregateType", event.status`,
        [eventId, this.workerId, sanitizedErrorCode]
      );
      const event = failed.rows[0];
      if (!event || event.status !== "dead_letter" || event.aggregateType !== "channel_inbound_event") return;

      const source = await client.query<{ id: string }>(
        `update channel_runtime.inbound_events
         set status = case when status in ('processed', 'ignored') then status else 'dead_letter' end,
             locked_at = null, locked_by = null,
             last_error_code = case
               when status in ('processed', 'ignored') then last_error_code
               else $4
             end,
             last_error_message = null,
             metadata = metadata || jsonb_build_object(
               'outboxStatus', 'dead_letter',
               'outboxEventId', $3::text,
               'outboxErrorCode', $4::text
             ),
             updated_at = now()
         where tenant_id = $1 and id = $2
         returning id`,
        [event.tenantId, event.aggregateId, event.id, sanitizedErrorCode]
      );
      if ((source.rowCount ?? 0) !== 1) {
        throw new Error("Channel inbound source missing for dead-lettered outbox event");
      }
    });
  }
}

function sanitizeErrorCode(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 64);
  return sanitized || "delivery_failed";
}

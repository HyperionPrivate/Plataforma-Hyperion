import type { DatabaseClient } from "@hyperion/database";

export const CHANNEL_DELIVERY_EVENT_TYPE = "channel.delivery.updated.v1" as const;

export interface ChannelDeliveryOutboxDelivery {
  id: string;
  tenantId: string;
  type: typeof CHANNEL_DELIVERY_EVENT_TYPE;
  version: 1;
  occurredAt: string;
  streamId: string;
  streamSequence: number;
  payload: Record<string, unknown>;
  destination: string;
}

interface ClaimedOutboxRow {
  id: string;
  tenantId: string;
  eventType: typeof CHANNEL_DELIVERY_EVENT_TYPE;
  eventVersion: 1;
  occurredAt: Date;
  streamId: string;
  streamSequence: string | number;
  payload: Record<string, unknown>;
}

/**
 * Claims only Channel -> PULSO delivery projections.  They share Channel's
 * owner outbox, but have an independent dispatcher and a monotonic stream per
 * PULSO message so retries cannot let a later delivery state overtake one that
 * is still pending.
 */
export class PostgresChannelDeliveryOutbox {
  private readonly destination: string;

  constructor(
    private readonly db: DatabaseClient,
    private readonly workerId: string,
    pulsoIrisUrl: string
  ) {
    this.destination = `${pulsoIrisUrl.replace(/\/$/, "")}/internal/v1/events/channel-delivery`;
  }

  async claim(limit: number): Promise<ChannelDeliveryOutboxDelivery[]> {
    const result = await this.db.query<ClaimedOutboxRow>(
      `with terminalized as (
         update channel_runtime.outbox_events
            set status = 'dead_letter', locked_at = null, locked_by = null,
                last_error_code = coalesce(last_error_code, 'lease_attempts_exhausted'), updated_at = now()
          where status = 'processing'
            and locked_at < now() - interval '2 minutes'
            and attempt_count >= max_attempts
            and event_type = $3
       ), candidates as (
         select candidate.id
           from channel_runtime.outbox_events candidate
          where (
              candidate.status in ('queued', 'retry_scheduled')
              or (candidate.status = 'processing' and candidate.locked_at < now() - interval '2 minutes')
            )
            and candidate.event_type = $3
            and candidate.next_attempt_at <= now()
            and candidate.attempt_count < candidate.max_attempts
            and candidate.stream_id is not null
            and candidate.stream_sequence is not null
            and not exists (
              select 1
                from channel_runtime.outbox_events predecessor
               where predecessor.tenant_id = candidate.tenant_id
                 and predecessor.event_type = $3
                 and predecessor.stream_id = candidate.stream_id
                 and predecessor.stream_sequence < candidate.stream_sequence
                 and predecessor.status <> 'published'
            )
          order by candidate.next_attempt_at, candidate.created_at, candidate.stream_sequence
          for update of candidate skip locked
          limit $2
       )
       update channel_runtime.outbox_events event
          set status = 'processing', attempt_count = event.attempt_count + 1,
              locked_at = now(), locked_by = $1, updated_at = now()
         from candidates
        where event.id = candidates.id
       returning event.id, event.tenant_id as "tenantId", event.event_type as "eventType",
                 event.event_version as "eventVersion", event.occurred_at as "occurredAt",
                 event.stream_id as "streamId", event.stream_sequence as "streamSequence", event.payload`,
      [this.workerId, Math.max(1, Math.min(20, Math.trunc(limit))), CHANNEL_DELIVERY_EVENT_TYPE]
    );

    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      type: row.eventType,
      version: row.eventVersion,
      occurredAt: row.occurredAt.toISOString(),
      streamId: row.streamId,
      streamSequence: requirePositiveSequence(row.streamSequence),
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
      [eventId, this.workerId, CHANNEL_DELIVERY_EVENT_TYPE]
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
      [eventId, this.workerId, sanitizeErrorCode(errorCode), CHANNEL_DELIVERY_EVENT_TYPE]
    );
  }
}

function requirePositiveSequence(value: string | number): number {
  const sequence = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("Claimed Channel delivery event has an invalid stream sequence");
  }
  return sequence;
}

function sanitizeErrorCode(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .slice(0, 64) || "delivery_failed"
  );
}

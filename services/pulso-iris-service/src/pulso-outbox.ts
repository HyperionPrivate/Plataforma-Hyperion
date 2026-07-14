import type { DatabaseClient } from "@hyperion/database";

export interface PulsoOutboxDelivery {
  id: string;
  tenantId: string;
  type: string;
  version: number;
  occurredAt: string;
  payload: Record<string, unknown>;
  streamId: string;
  streamSequence: number;
  destination: string;
}

interface ClaimedOutboxRow {
  id: string;
  tenantId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: Date;
  payload: Record<string, unknown>;
  streamId: string;
  streamSequence: string | number;
  sourceStreamId: string;
  sourceStreamSequence: string | number;
}

export const PULSO_MESSAGE_EVENT_V1_TYPE = "pulso.message.received.v1" as const;
export const PULSO_MESSAGE_EVENT_V2_TYPE = "pulso.message.received.v2" as const;

export class PostgresPulsoOutbox {
  private readonly destination: string;

  constructor(
    private readonly db: DatabaseClient,
    private readonly workerId: string,
    agentUrl: string
  ) {
    this.destination = `${agentUrl.replace(/\/$/, "")}/internal/v1/events/pulso-message-received`;
  }

  async claim(limit: number, tenantScope?: string): Promise<PulsoOutboxDelivery[]> {
    const scopedTenantId = tenantScope?.trim() || null;
    const result = await this.db.query<ClaimedOutboxRow>(
      `with terminalized as (
         update pulso_iris.outbox_events
         set status = 'dead_letter', locked_at = null, locked_by = null,
             last_error_code = coalesce(last_error_code, 'lease_attempts_exhausted'), updated_at = now()
         where status = 'processing' and locked_at < now() - interval '2 minutes'
           and ($3::uuid is null or tenant_id = $3::uuid)
           and attempt_count >= max_attempts
       ), candidates as (
         select candidate.id from pulso_iris.outbox_events candidate
         where (candidate.status in ('queued', 'retry_scheduled')
                or (candidate.status = 'processing' and candidate.locked_at < now() - interval '2 minutes'))
           and ($3::uuid is null or candidate.tenant_id = $3::uuid)
           and candidate.stream_id is not null
           and candidate.stream_sequence is not null
           and candidate.source_stream_id is not null
           and candidate.source_stream_sequence is not null
           and candidate.next_attempt_at <= now() and candidate.attempt_count < candidate.max_attempts
           and not exists (
             select 1
             from pulso_iris.outbox_events predecessor
             where predecessor.tenant_id = candidate.tenant_id
               and predecessor.stream_id = candidate.stream_id
               and predecessor.stream_sequence < candidate.stream_sequence
               and predecessor.status <> 'published'
           )
         order by candidate.next_attempt_at, candidate.created_at
         for update of candidate skip locked limit $2
       )
       update pulso_iris.outbox_events event
       set status = 'processing', attempt_count = event.attempt_count + 1,
           locked_at = now(), locked_by = $1, updated_at = now()
       from candidates where event.id = candidates.id
       returning event.id, event.tenant_id as "tenantId", event.event_type as "eventType",
                 event.event_version as "eventVersion", event.occurred_at as "occurredAt", event.payload,
                 event.stream_id as "streamId", event.stream_sequence as "streamSequence",
                 event.source_stream_id as "sourceStreamId",
                 event.source_stream_sequence as "sourceStreamSequence"`,
      [this.workerId, Math.max(1, Math.min(20, Math.trunc(limit))), scopedTenantId]
    );
    return result.rows.map((row) => {
      if (row.eventType !== PULSO_MESSAGE_EVENT_V1_TYPE && row.eventType !== PULSO_MESSAGE_EVENT_V2_TYPE) {
        throw new Error(`Unsupported PULSO outbox contract: ${row.eventType}`);
      }
      const expectedVersion = row.eventType === PULSO_MESSAGE_EVENT_V1_TYPE ? 1 : 2;
      if (row.eventVersion !== expectedVersion) {
        throw new Error(`Invalid PULSO outbox contract version: ${row.eventType}@${row.eventVersion}`);
      }
      const streamSequence = requirePositiveSequence(row.streamSequence, "streamSequence");
      const sourceStreamSequence = requirePositiveSequence(row.sourceStreamSequence, "sourceStreamSequence");
      return {
        id: row.id,
        tenantId: row.tenantId,
        type: PULSO_MESSAGE_EVENT_V2_TYPE,
        version: 2,
        occurredAt: row.occurredAt.toISOString(),
        streamId: row.streamId,
        streamSequence,
        payload: {
          ...row.payload,
          sourceStreamId: row.sourceStreamId,
          sourceStreamSequence
        },
        destination: this.destination
      };
    });
  }

  async complete(eventId: string): Promise<void> {
    await this.db.query(
      `update pulso_iris.outbox_events
       set status = 'published', published_at = now(), locked_at = null, locked_by = null,
           last_error_code = null, updated_at = now()
       where id = $1 and status = 'processing' and locked_by = $2`,
      [eventId, this.workerId]
    );
  }

  async fail(eventId: string, errorCode: string): Promise<void> {
    await this.db.query(
      `update pulso_iris.outbox_events
       set status = case when attempt_count >= max_attempts then 'dead_letter' else 'retry_scheduled' end,
           next_attempt_at = case when attempt_count >= max_attempts then next_attempt_at
             else now() + make_interval(secs => least(300, power(2, least(attempt_count, 8))::integer)) end,
           locked_at = null, locked_by = null, last_error_code = $3, updated_at = now()
       where id = $1 and status = 'processing' and locked_by = $2`,
      [eventId, this.workerId, sanitizeErrorCode(errorCode)]
    );
  }
}

function requirePositiveSequence(value: string | number, name: string): number {
  const sequence = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error(`PULSO outbox ${name} is invalid`);
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

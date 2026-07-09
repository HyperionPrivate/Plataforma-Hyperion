import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";
import type { WhatsAppConnectionStatus, WhatsAppDeliveryUpdate, WhatsAppInboundText } from "./types.js";

export interface PersistInboundResult {
  eventId: string;
  threadBindingId: string;
  inserted: boolean;
}

export interface ClaimedInboundEvent {
  id: string;
  tenantId: string;
  threadBindingId: string;
  externalMessageId: string;
  phoneHash: string;
  phoneMasked: string;
  body: string;
  occurredAt: string;
  attemptCount: number;
}

export interface EnqueueOutboundInput {
  tenantId: string;
  threadBindingId: string;
  messageId: string;
  body: string;
  idempotencyKey: string;
}

export interface EnqueueOutboundResult {
  id: string;
  inserted: boolean;
}

export interface ClaimedOutboundMessage {
  id: string;
  tenantId: string;
  providerAddress: string;
  phoneHash: string;
  messageId: string;
  body: string;
  attemptCount: number;
  maxAttempts: number;
  workerId: string;
}

export interface ChannelRepository {
  projectConnection(tenantId: string, status: WhatsAppConnectionStatus): Promise<void>;
  getConnection(tenantId: string): Promise<WhatsAppConnectionStatus | undefined>;
  listRestorableTenantIds(): Promise<string[]>;
  persistInbound(message: WhatsAppInboundText): Promise<PersistInboundResult>;
  claimInbound(workerId: string): Promise<ClaimedInboundEvent | undefined>;
  completeInbound(tenantId: string, eventId: string, workerId: string): Promise<boolean>;
  failInbound(tenantId: string, eventId: string, workerId: string, errorCode: string): Promise<boolean>;
  enqueueOutbound(input: EnqueueOutboundInput): Promise<EnqueueOutboundResult>;
  claimOutbound(workerId: string): Promise<ClaimedOutboundMessage | undefined>;
  markOutboundSending(message: ClaimedOutboundMessage): Promise<boolean>;
  markOutboundSent(message: ClaimedOutboundMessage, providerMessageId: string, sentAt: Date): Promise<boolean>;
  markOutboundFailed(message: ClaimedOutboundMessage, errorCode: string): Promise<boolean>;
  markOutboundUncertain(message: ClaimedOutboundMessage, providerMessageId?: string, sentAt?: Date): Promise<boolean>;
  updateDelivery(update: WhatsAppDeliveryUpdate): Promise<void>;
}

interface ConnectionRow {
  providerMode: "whatsapp_web_test";
  state: WhatsAppConnectionStatus["state"];
  phoneMasked: string | null;
  lastActivityAt: Date | null;
  lastError: string | null;
  qrExpiresAt: Date | null;
  sessionRestorable: boolean;
}

export class PostgresChannelRepository implements ChannelRepository {
  constructor(private readonly db: DatabaseClient) {}

  async projectConnection(tenantId: string, status: WhatsAppConnectionStatus): Promise<void> {
    await this.db.query(
      `insert into channel_runtime.connections (
         tenant_id, provider_mode, state, phone_masked, session_restorable,
         qr_expires_at, last_activity_at, last_error_code, connected_at,
         disconnected_at, updated_at
       )
       values (
         $1, $2, $3, $4, $5, $6, $7, $8,
         case when $3 = 'ready' then now() else null end,
         case when $3 = 'disconnected' then now() else null end,
         now()
       )
       on conflict (tenant_id) do update set
         provider_mode = excluded.provider_mode,
         state = excluded.state,
         phone_masked = excluded.phone_masked,
         session_restorable = excluded.session_restorable,
         qr_expires_at = excluded.qr_expires_at,
         last_activity_at = coalesce(excluded.last_activity_at, channel_runtime.connections.last_activity_at),
         last_error_code = excluded.last_error_code,
         last_error_message = null,
         connected_at = case
           when excluded.state = 'ready' then coalesce(channel_runtime.connections.connected_at, now())
           else channel_runtime.connections.connected_at
         end,
         disconnected_at = case
           when excluded.state = 'disconnected' then now()
           when excluded.state = 'ready' then null
           else channel_runtime.connections.disconnected_at
         end,
         updated_at = now()`,
      [
        tenantId,
        status.providerMode,
        status.state,
        status.phoneMasked ?? null,
        status.sessionRestorable,
        status.qrExpiresAt ?? null,
        status.lastActivityAt ?? null,
        sanitizeErrorCode(status.lastError)
      ]
    );
  }

  async getConnection(tenantId: string): Promise<WhatsAppConnectionStatus | undefined> {
    const result = await this.db.query<ConnectionRow>(
      `select provider_mode as "providerMode", state, phone_masked as "phoneMasked",
              last_activity_at as "lastActivityAt", last_error_code as "lastError",
              qr_expires_at as "qrExpiresAt", session_restorable as "sessionRestorable"
       from channel_runtime.connections
       where tenant_id = $1`,
      [tenantId]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      providerMode: row.providerMode,
      state: row.state,
      phoneMasked: row.phoneMasked ?? undefined,
      lastActivityAt: row.lastActivityAt?.toISOString(),
      lastError: row.lastError ?? undefined,
      qrExpiresAt: row.qrExpiresAt?.toISOString(),
      sessionRestorable: row.sessionRestorable
    };
  }

  async listRestorableTenantIds(): Promise<string[]> {
    const result = await this.db.query<{ tenantId: string }>(
      `select tenant_id as "tenantId"
       from channel_runtime.connections
       where session_restorable = true and state <> 'disconnected'
       order by created_at`,
      []
    );
    return result.rows.map((row) => row.tenantId);
  }

  async persistInbound(message: WhatsAppInboundText): Promise<PersistInboundResult> {
    return this.db.transaction(async (client) => {
      const connectionId = await requireConnection(client, message.tenantId);
      const bindingId = await upsertThreadBinding(client, connectionId, message);
      const inserted = await client.query<{ id: string }>(
        `insert into channel_runtime.inbound_events (
           tenant_id, connection_id, thread_binding_id, provider,
           external_message_id, body, status, occurred_at
         )
         values ($1, $2, $3, $4, $5, $6, 'received', $7)
         on conflict (tenant_id, provider, external_message_id) do nothing
         returning id`,
        [
          message.tenantId,
          connectionId,
          bindingId,
          message.provider,
          message.externalMessageId,
          message.body,
          message.receivedAt
        ]
      );
      await client.query(
        `update channel_runtime.thread_bindings
         set last_inbound_at = greatest(coalesce(last_inbound_at, $3), $3), updated_at = now()
         where tenant_id = $1 and id = $2`,
        [message.tenantId, bindingId, message.receivedAt]
      );
      if (inserted.rows[0]) {
        return { eventId: inserted.rows[0].id, threadBindingId: bindingId, inserted: true };
      }
      const existing = await client.query<{ id: string }>(
        `select id from channel_runtime.inbound_events
         where tenant_id = $1 and provider = $2 and external_message_id = $3`,
        [message.tenantId, message.provider, message.externalMessageId]
      );
      return { eventId: existing.rows[0]?.id ?? "", threadBindingId: bindingId, inserted: false };
    });
  }

  async claimInbound(workerId: string): Promise<ClaimedInboundEvent | undefined> {
    const result = await this.db.query<{
      id: string;
      tenantId: string;
      threadBindingId: string;
      externalMessageId: string;
      phoneHash: string;
      phoneMasked: string;
      body: string;
      occurredAt: Date;
      attemptCount: number;
    }>(
      `with claimed as (
         select * from channel_runtime.claim_next_inbound_event($1)
       )
       select c.id, c.tenant_id as "tenantId", c.thread_binding_id as "threadBindingId",
              c.external_message_id as "externalMessageId", b.phone_e164_hash as "phoneHash",
              b.phone_masked as "phoneMasked", c.body,
              c.occurred_at as "occurredAt", c.attempt_count as "attemptCount"
       from claimed c
       join channel_runtime.thread_bindings b
         on b.tenant_id = c.tenant_id and b.id = c.thread_binding_id`,
      [workerId]
    );
    const row = result.rows[0];
    return row ? { ...row, occurredAt: row.occurredAt.toISOString() } : undefined;
  }

  async completeInbound(tenantId: string, eventId: string, workerId: string): Promise<boolean> {
    const result = await this.db.query(
      `update channel_runtime.inbound_events
       set status = 'processed', processed_at = now(), locked_at = null,
           locked_by = null, last_error_code = null, last_error_message = null, updated_at = now()
       where tenant_id = $1 and id = $2 and status = 'processing' and locked_by = $3`,
      [tenantId, eventId, workerId]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async failInbound(tenantId: string, eventId: string, workerId: string, errorCode: string): Promise<boolean> {
    const result = await this.db.query(
      `update channel_runtime.inbound_events
       set status = case when attempt_count >= max_attempts then 'dead_letter' else 'retry_scheduled' end,
           next_attempt_at = case
             when attempt_count >= max_attempts then next_attempt_at
             else now() + make_interval(secs => least(60, power(2, attempt_count)::integer))
           end,
           locked_at = null, locked_by = null, last_error_code = $4,
           last_error_message = null, updated_at = now()
       where tenant_id = $1 and id = $2 and status = 'processing' and locked_by = $3`,
      [tenantId, eventId, workerId, sanitizeErrorCode(errorCode) ?? "processing_failed"]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async enqueueOutbound(input: EnqueueOutboundInput): Promise<EnqueueOutboundResult> {
    const result = await this.db.query<{ id: string; inserted: boolean }>(
      `with binding as (
         select b.connection_id
         from channel_runtime.thread_bindings b
         join pulso_iris.messages m
           on m.tenant_id = b.tenant_id and m.id = $3
         where b.tenant_id = $1 and b.id = $2 and b.status = 'active'
       ), inserted as (
         insert into channel_runtime.outbound_messages (
           tenant_id, connection_id, thread_binding_id, message_id,
           provider, idempotency_key, body, status
         )
         select $1, connection_id, $2, $3, 'whatsapp_web_test', $4, $5, 'queued'
         from binding
         on conflict (tenant_id, provider, idempotency_key) do nothing
         returning id
       )
       select id, true as inserted from inserted
       union all
       select id, false as inserted
       from channel_runtime.outbound_messages
       where tenant_id = $1 and provider = 'whatsapp_web_test' and idempotency_key = $4
         and not exists (select 1 from inserted)
       limit 1`,
      [input.tenantId, input.threadBindingId, input.messageId, input.idempotencyKey, input.body]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Thread binding or message not found");
    return row;
  }

  async claimOutbound(workerId: string): Promise<ClaimedOutboundMessage | undefined> {
    const result = await this.db.query<{
      id: string;
      tenantId: string;
      providerAddress: string;
      phoneHash: string;
      messageId: string;
      body: string;
      attemptCount: number;
      maxAttempts: number;
      workerId: string;
    }>(
      `with claimed as (
         select * from channel_runtime.claim_next_outbound_message($1)
       )
       select c.id, c.tenant_id as "tenantId", b.external_thread_id as "providerAddress",
              b.phone_e164_hash as "phoneHash",
              c.message_id as "messageId", c.body, c.attempt_count as "attemptCount",
              c.max_attempts as "maxAttempts", c.locked_by as "workerId"
       from claimed c
       join channel_runtime.thread_bindings b
         on b.tenant_id = c.tenant_id and b.id = c.thread_binding_id`,
      [workerId]
    );
    return result.rows[0];
  }

  async markOutboundSending(message: ClaimedOutboundMessage): Promise<boolean> {
    const result = await this.db.query(
      `update channel_runtime.outbound_messages
       set status = 'sending', updated_at = now()
       where tenant_id = $1 and id = $2 and status = 'processing' and locked_by = $3`,
      [message.tenantId, message.id, message.workerId]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async markOutboundSent(message: ClaimedOutboundMessage, providerMessageId: string, sentAt: Date): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const transitioned = await client.query<{ messageId: string }>(
        `update channel_runtime.outbound_messages
         set status = 'sent', provider_message_id = $3, sent_at = $4,
             locked_at = null, locked_by = null, last_error_code = null,
             last_error_message = null, updated_at = now()
         where tenant_id = $1 and id = $2 and status = 'sending' and locked_by = $5
         returning message_id as "messageId"`,
        [message.tenantId, message.id, providerMessageId, sentAt, message.workerId]
      );
      if (!transitioned.rows[0]) return false;
      await client.query(
        `update pulso_iris.messages
         set provider = 'whatsapp_web_test', provider_message_id = $3, delivery_status = 'sent'
         where tenant_id = $1 and id = $2`,
        [message.tenantId, message.messageId, providerMessageId]
      );
      await client.query(
        `update channel_runtime.thread_bindings b
         set last_outbound_at = $3, updated_at = now()
         from channel_runtime.outbound_messages o
         where o.tenant_id = $1 and o.id = $2
           and b.tenant_id = o.tenant_id and b.id = o.thread_binding_id`,
        [message.tenantId, message.id, sentAt]
      );
      return true;
    });
  }

  async markOutboundFailed(message: ClaimedOutboundMessage, errorCode: string): Promise<boolean> {
    const terminal = message.attemptCount >= message.maxAttempts;
    return this.db.transaction(async (client) => {
      const transitioned = await client.query<{ messageId: string }>(
        `update channel_runtime.outbound_messages
         set status = $3,
             next_attempt_at = case when $3 = 'retry_scheduled'
               then now() + make_interval(secs => least(60, power(2, attempt_count)::integer))
               else next_attempt_at end,
             locked_at = null, locked_by = null, last_error_code = $4,
             last_error_message = null, updated_at = now()
         where tenant_id = $1 and id = $2 and status = 'sending' and locked_by = $5
         returning message_id as "messageId"`,
        [
          message.tenantId,
          message.id,
          terminal ? "dead_letter" : "retry_scheduled",
          sanitizeErrorCode(errorCode) ?? "send_failed",
          message.workerId
        ]
      );
      if (!transitioned.rows[0]) return false;
      if (terminal) {
        await client.query(
          `update pulso_iris.messages set delivery_status = 'failed'
           where tenant_id = $1 and id = $2`,
          [message.tenantId, message.messageId]
        );
      }
      return true;
    });
  }

  async markOutboundUncertain(
    message: ClaimedOutboundMessage,
    providerMessageId?: string,
    sentAt?: Date
  ): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const transitioned = await client.query<{ messageId: string }>(
        `update channel_runtime.outbound_messages
         set status = 'reconciliation_required', locked_at = null, locked_by = null,
             last_error_code = 'delivery_outcome_unknown', last_error_message = null,
             provider_message_id = coalesce($4, provider_message_id),
             sent_at = coalesce($5, sent_at),
             updated_at = now()
         where tenant_id = $1 and id = $2
           and (
             (status = 'sending' and locked_by = $3)
             or status = 'reconciliation_required'
           )
         returning message_id as "messageId"`,
        [message.tenantId, message.id, message.workerId, providerMessageId ?? null, sentAt ?? null]
      );
      if (!transitioned.rows[0]) return false;
      await client.query(
        `update pulso_iris.messages
         set delivery_status = 'failed',
             metadata = coalesce(metadata, '{}'::jsonb)
               || '{"deliveryReconciliationRequired":true}'::jsonb
         where tenant_id = $1 and id = $2`,
        [message.tenantId, message.messageId]
      );
      return true;
    });
  }

  async updateDelivery(update: WhatsAppDeliveryUpdate): Promise<void> {
    await this.db.transaction(async (client) => {
      const result = await client.query<{ messageId: string }>(
        `update channel_runtime.outbound_messages
         set status = case
               when $4 = 'failed' then 'failed'
               when $4 in ('delivered', 'read') then 'delivered'
               else status
             end,
             delivered_at = case when $4 in ('delivered', 'read') then $5 else delivered_at end,
             last_error_code = case when $4 = 'failed' then 'provider_delivery_failed' else null end,
             updated_at = now()
         where tenant_id = $1 and provider = $2 and provider_message_id = $3
         returning message_id as "messageId"`,
        [update.tenantId, update.provider, update.providerMessageId, update.status, update.occurredAt]
      );
      const messageId = result.rows[0]?.messageId;
      if (messageId) {
        await client.query(
          `update pulso_iris.messages
           set delivery_status = $3,
               delivered_at = case when $3 in ('delivered', 'read') then $4 else delivered_at end
           where tenant_id = $1 and id = $2`,
          [update.tenantId, messageId, update.status, update.occurredAt]
        );
      }
    });
  }
}

async function requireConnection(client: DatabaseExecutor, tenantId: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `select id from channel_runtime.connections where tenant_id = $1 for update`,
    [tenantId]
  );
  if (!result.rows[0]) throw new Error("WhatsApp connection is not initialized");
  return result.rows[0].id;
}

async function upsertThreadBinding(
  client: DatabaseExecutor,
  connectionId: string,
  message: WhatsAppInboundText
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into channel_runtime.thread_bindings (
       tenant_id, connection_id, provider, external_thread_id,
       phone_e164_hash, phone_masked, status
     )
     values ($1, $2, $3, $4, $5, $6, 'active')
     on conflict do nothing
     returning id`,
    [message.tenantId, connectionId, message.provider, message.providerAddress, message.phoneHash, message.phoneMasked]
  );
  let id = inserted.rows[0]?.id;
  if (!id) {
    const existing = await client.query<{ id: string }>(
      `select id from channel_runtime.thread_bindings
       where tenant_id = $1 and provider = $2
         and (external_thread_id = $3 or phone_e164_hash = $4)
       order by case when external_thread_id = $3 then 0 else 1 end
       limit 1
       for update`,
      [message.tenantId, message.provider, message.providerAddress, message.phoneHash]
    );
    id = existing.rows[0]?.id;
  }
  if (!id) throw new Error("Unable to create WhatsApp thread binding");
  await client.query(
    `update channel_runtime.thread_bindings
     set connection_id = $3, external_thread_id = $4, phone_e164_hash = $5,
         phone_masked = $6, status = 'active', updated_at = now()
     where tenant_id = $1 and id = $2`,
    [message.tenantId, id, connectionId, message.providerAddress, message.phoneHash, message.phoneMasked]
  );
  return id;
}

function sanitizeErrorCode(value: string | undefined): string | null {
  if (!value) return null;
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 64);
  return sanitized || null;
}

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
  updateDelivery(update: WhatsAppDeliveryUpdate): Promise<boolean>;
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
    await this.db.transaction(async (client) => {
      await applyChannelProjectionTimeouts(client);
      await client.query(
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
    });
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
      await applyChannelProjectionTimeouts(client);
      const replay = await findInboundReplay(client, message);
      if (replay) return replay;

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
      if (inserted.rows[0]) {
        await client.query(
          `update channel_runtime.thread_bindings
           set last_inbound_at = greatest(coalesce(last_inbound_at, $3), $3), updated_at = now()
           where tenant_id = $1 and id = $2`,
          [message.tenantId, bindingId, message.receivedAt]
        );
        return { eventId: inserted.rows[0].id, threadBindingId: bindingId, inserted: true };
      }

      const concurrentReplay = await findInboundReplay(client, message);
      if (!concurrentReplay) throw new Error("Inbound event identity conflict");
      return concurrentReplay;
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
    return this.db.transaction(async (client) => {
      await applyChannelProjectionTimeouts(client);
      const inserted = await client.query<{ id: string }>(
        `insert into channel_runtime.outbound_messages (
           tenant_id, connection_id, thread_binding_id, message_id,
           provider, idempotency_key, body, status
         )
         select $1, b.connection_id, $2, $3, 'whatsapp_web_test', $4, m.body, 'queued'
         from channel_runtime.thread_bindings b
         join pulso_iris.messages m
           on m.tenant_id = b.tenant_id and m.id = $3
         where b.tenant_id = $1 and b.id = $2 and b.status = 'active'
           and b.conversation_id is not null
            and m.conversation_id = b.conversation_id
            and m.sender = 'sofia'
            and m.provider = 'whatsapp_web_test'
            and m.delivery_status = 'queued'
            and m.body = $5
         on conflict do nothing
         returning id`,
        [input.tenantId, input.threadBindingId, input.messageId, input.idempotencyKey, input.body]
      );
      if (inserted.rows[0]) return { id: inserted.rows[0].id, inserted: true };

      const existing = await client.query<{ id: string }>(
        `select o.id
         from channel_runtime.thread_bindings b
         join pulso_iris.messages m
           on m.tenant_id = b.tenant_id and m.id = $3
         join channel_runtime.outbound_messages o
           on o.tenant_id = b.tenant_id and o.connection_id = b.connection_id
          and o.thread_binding_id = b.id and o.message_id = m.id and o.body = m.body
         where b.tenant_id = $1 and b.id = $2 and b.status = 'active'
           and b.conversation_id is not null
           and m.conversation_id = b.conversation_id
           and m.sender = 'sofia' and m.body = $5
           and o.provider = 'whatsapp_web_test'
           and not exists (
             select 1
             from channel_runtime.outbound_messages conflicting_key
             where conflicting_key.tenant_id = $1
               and conflicting_key.provider = 'whatsapp_web_test'
               and conflicting_key.idempotency_key = $4
               and conflicting_key.message_id <> $3
           )
         for update of o`,
        [input.tenantId, input.threadBindingId, input.messageId, input.idempotencyKey, input.body]
      );
      const row = existing.rows[0];
      if (!row) throw new Error("Thread binding or message not found");
      return { id: row.id, inserted: false };
    });
  }

  async claimOutbound(workerId: string): Promise<ClaimedOutboundMessage | undefined> {
    return this.db.transaction(async (client) => {
      await applyChannelProjectionTimeouts(client);
      const claimed = await client.query<{
        id: string;
        tenantId: string;
        threadBindingId: string;
        messageId: string;
        body: string;
        attemptCount: number;
        maxAttempts: number;
        workerId: string;
      }>(
        `select id, tenant_id as "tenantId", thread_binding_id as "threadBindingId",
                message_id as "messageId", body, attempt_count as "attemptCount",
                max_attempts as "maxAttempts", locked_by as "workerId"
         from channel_runtime.claim_next_outbound_message($1)`,
        [workerId]
      );
      const candidate = claimed.rows[0];
      if (!candidate) return undefined;

      const valid = await client.query<{ providerAddress: string; phoneHash: string }>(
        `select b.external_thread_id as "providerAddress", b.phone_e164_hash as "phoneHash"
         from channel_runtime.outbound_messages o
         join channel_runtime.thread_bindings b
           on b.tenant_id = o.tenant_id and b.id = o.thread_binding_id
         join pulso_iris.messages m
           on m.tenant_id = o.tenant_id and m.id = o.message_id
         where o.tenant_id = $1 and o.id = $2
           and o.status = 'processing' and o.locked_by = $3
           and b.id = $4 and b.status = 'active'
           and b.connection_id = o.connection_id and b.provider = o.provider
           and b.conversation_id is not null
            and m.conversation_id = b.conversation_id
            and m.sender = 'sofia'
            and m.body = o.body
            and m.provider = o.provider
            and m.delivery_status = 'queued'
         for update of o`,
        [candidate.tenantId, candidate.id, candidate.workerId, candidate.threadBindingId]
      );
      const source = valid.rows[0];
      if (!source) {
        await cancelClaimedOutbound(client, candidate.tenantId, candidate.id, candidate.workerId);
        return undefined;
      }

      return { ...candidate, ...source };
    });
  }

  async markOutboundSending(message: ClaimedOutboundMessage): Promise<boolean> {
    return this.db.transaction(async (client) => {
      await applyChannelProjectionTimeouts(client);
      const result = await client.query(
        `update channel_runtime.outbound_messages o
         set status = 'sending', updated_at = now()
         from channel_runtime.thread_bindings b, pulso_iris.messages m
         where o.tenant_id = $1 and o.id = $2
           and o.status = 'processing' and o.locked_by = $3
           and b.tenant_id = o.tenant_id and b.id = o.thread_binding_id
           and b.status = 'active' and b.conversation_id is not null
           and b.connection_id = o.connection_id and b.provider = o.provider
           and b.external_thread_id = $4 and b.phone_e164_hash = $5
            and m.tenant_id = o.tenant_id and m.id = o.message_id
            and o.message_id = $7
            and m.conversation_id = b.conversation_id
            and m.sender = 'sofia'
            and m.provider = o.provider and m.delivery_status = 'queued'
            and m.body = o.body and o.body = $6`,
        [
          message.tenantId,
          message.id,
          message.workerId,
          message.providerAddress,
          message.phoneHash,
          message.body,
          message.messageId
        ]
      );
      if ((result.rowCount ?? 0) === 1) return true;
      await cancelClaimedOutbound(client, message.tenantId, message.id, message.workerId);
      return false;
    });
  }

  async markOutboundSent(message: ClaimedOutboundMessage, providerMessageId: string, sentAt: Date): Promise<boolean> {
    return this.db.transaction(async (client) => {
      await applyChannelProjectionTimeouts(client);
      await lockDeliveryIdentity(client, message.tenantId, "whatsapp_web_test", providerMessageId);
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
          set provider = 'whatsapp_web_test', provider_message_id = $3,
              delivery_status = case
                when delivery_status in ('delivered', 'read') then delivery_status
                else 'sent'
              end
          where tenant_id = $1 and id = $2`,
        [message.tenantId, transitioned.rows[0].messageId, providerMessageId]
      );
      await client.query(
        `update channel_runtime.thread_bindings b
         set last_outbound_at = $3, updated_at = now()
         from channel_runtime.outbound_messages o
         where o.tenant_id = $1 and o.id = $2
           and b.tenant_id = o.tenant_id and b.id = o.thread_binding_id`,
        [message.tenantId, message.id, sentAt]
      );
      await reconcilePendingDeliveryReceipts(client, message.tenantId, "whatsapp_web_test", providerMessageId);
      return true;
    });
  }

  async markOutboundFailed(message: ClaimedOutboundMessage, errorCode: string): Promise<boolean> {
    const terminal = message.attemptCount >= message.maxAttempts;
    return this.db.transaction(async (client) => {
      await applyChannelProjectionTimeouts(client);
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
          `update pulso_iris.messages
            set delivery_status = case
              when delivery_status in ('delivered', 'read') then delivery_status
              else 'failed'
            end
            where tenant_id = $1 and id = $2`,
          [message.tenantId, transitioned.rows[0].messageId]
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
      await applyChannelProjectionTimeouts(client);
      if (providerMessageId) {
        await lockDeliveryIdentity(client, message.tenantId, "whatsapp_web_test", providerMessageId);
      }
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
         set delivery_status = case
               when delivery_status in ('delivered', 'read') then delivery_status
               else 'failed'
             end,
             metadata = coalesce(metadata, '{}'::jsonb)
               || '{"deliveryReconciliationRequired":true}'::jsonb
         where tenant_id = $1 and id = $2`,
        [message.tenantId, transitioned.rows[0].messageId]
      );
      if (providerMessageId) {
        await reconcilePendingDeliveryReceipts(client, message.tenantId, "whatsapp_web_test", providerMessageId);
      }
      return true;
    });
  }

  async updateDelivery(update: WhatsAppDeliveryUpdate): Promise<boolean> {
    return this.db.transaction(async (client) => {
      await applyChannelProjectionTimeouts(client);
      await lockDeliveryIdentity(client, update.tenantId, update.provider, update.providerMessageId);
      await client.query(
        `insert into channel_runtime.delivery_receipts (
           tenant_id, provider, provider_message_id, status, occurred_at
         ) values ($1, $2, $3, $4, $5)
         on conflict (tenant_id, provider, provider_message_id, status)
         do update set occurred_at = least(
           channel_runtime.delivery_receipts.occurred_at,
           excluded.occurred_at
         )`,
        [update.tenantId, update.provider, update.providerMessageId, update.status, update.occurredAt]
      );
      await reconcilePendingDeliveryReceipts(client, update.tenantId, update.provider, update.providerMessageId);
      await client.query(
        `with expired as (
           select provider, provider_message_id
           from channel_runtime.delivery_receipts
           where tenant_id = $1
           group by provider, provider_message_id
           having max(received_at) < now() - interval '7 days'
         )
         delete from channel_runtime.delivery_receipts receipt
         using expired
         where receipt.tenant_id = $1
           and receipt.provider = expired.provider
           and receipt.provider_message_id = expired.provider_message_id`,
        [update.tenantId]
      );
      await client.query(
        `with ranked_identities as (
           select provider, provider_message_id,
                  row_number() over (
                    order by max(received_at) desc, provider_message_id desc, provider desc
                  ) as identity_rank
           from channel_runtime.delivery_receipts
           where tenant_id = $1
           group by provider, provider_message_id
         ), excess as (
           select provider, provider_message_id
           from ranked_identities
           where identity_rank > 2000
         )
         delete from channel_runtime.delivery_receipts receipt
         using excess
         where receipt.tenant_id = $1
           and receipt.provider = excess.provider
           and receipt.provider_message_id = excess.provider_message_id`,
        [update.tenantId]
      );
      return true;
    });
  }
}

async function lockDeliveryIdentity(
  client: DatabaseExecutor,
  tenantId: string,
  provider: "whatsapp_web_test",
  providerMessageId: string
): Promise<void> {
  await client.query(
    `select pg_advisory_xact_lock(
       hashtextextended(concat_ws(chr(31), $1::text, $2::text, $3::text), 0)
     )`,
    [tenantId, provider, providerMessageId]
  );
}

async function reconcilePendingDeliveryReceipts(
  client: DatabaseExecutor,
  tenantId: string,
  provider: "whatsapp_web_test",
  providerMessageId: string
): Promise<boolean> {
  const pending = await client.query<{ status: "delivered" | "read" | "failed"; occurredAt: Date }>(
    `select case
              when bool_or(status = 'read') then 'read'
              when bool_or(status = 'delivered') then 'delivered'
              else 'failed'
            end as status,
            coalesce(
              min(occurred_at) filter (where status in ('delivered', 'read')),
              min(occurred_at)
            ) as "occurredAt"
     from channel_runtime.delivery_receipts
     where tenant_id = $1 and provider = $2 and provider_message_id = $3
     having count(*) > 0`,
    [tenantId, provider, providerMessageId]
  );
  const receipt = pending.rows[0];
  if (!receipt) return false;

  const outbound = await client.query<{ messageId: string }>(
    `update channel_runtime.outbound_messages
     set status = case
           when $4 in ('delivered', 'read') then 'delivered'
           when $4 = 'failed' and status <> 'delivered' then 'failed'
           else status
         end,
         delivered_at = case
           when $4 in ('delivered', 'read') and (delivered_at is null or $5 < delivered_at) then $5
           else delivered_at
         end,
         last_error_code = case
           when $4 in ('delivered', 'read') then null
           when $4 = 'failed' and status <> 'delivered' then 'provider_delivery_failed'
           else last_error_code
         end,
         updated_at = now()
     where tenant_id = $1 and provider = $2 and provider_message_id = $3
     returning message_id as "messageId"`,
    [tenantId, provider, providerMessageId, receipt.status, receipt.occurredAt]
  );
  const messageId = outbound.rows[0]?.messageId;
  if (!messageId) return false;

  await client.query(
    `update pulso_iris.messages
     set delivery_status = case
           when delivery_status = 'read' then 'read'
           when $3 = 'read' then 'read'
           when delivery_status = 'delivered' then 'delivered'
           when $3 = 'delivered' then 'delivered'
           when $3 = 'failed' then 'failed'
           else delivery_status
         end,
         delivered_at = case
           when $3 in ('delivered', 'read') and (delivered_at is null or $4 < delivered_at) then $4
           else delivered_at
         end,
         metadata = coalesce(metadata, '{}'::jsonb) - 'deliveryReconciliationRequired'
     where tenant_id = $1 and id = $2`,
    [tenantId, messageId, receipt.status, receipt.occurredAt]
  );
  await client.query(
    `delete from channel_runtime.delivery_receipts
     where tenant_id = $1 and provider = $2 and provider_message_id = $3`,
    [tenantId, provider, providerMessageId]
  );
  return true;
}

async function applyChannelProjectionTimeouts(client: DatabaseExecutor): Promise<void> {
  // Keep the provider's 10s default attempt timeout above PostgreSQL's server-side
  // cancellation window so retries never accumulate orphaned transactions.
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '7s'");
  await client.query("set local idle_in_transaction_session_timeout = '9s'");
}

async function findInboundReplay(
  client: DatabaseExecutor,
  message: WhatsAppInboundText
): Promise<PersistInboundResult | undefined> {
  const existing = await client.query<{
    eventId: string;
    threadBindingId: string;
    body: string;
    phoneHash: string;
  }>(
    `select e.id as "eventId", e.thread_binding_id as "threadBindingId",
            e.body, b.phone_e164_hash as "phoneHash"
     from channel_runtime.inbound_events e
     join channel_runtime.thread_bindings b
       on b.tenant_id = e.tenant_id and b.id = e.thread_binding_id
      where e.tenant_id = $1 and e.provider = $2 and e.external_message_id = $3`,
    [message.tenantId, message.provider, message.externalMessageId]
  );
  const row = existing.rows[0];
  if (!row) return undefined;
  if (row.body !== message.body || row.phoneHash !== message.phoneHash) {
    throw new Error("Inbound event identity conflict");
  }
  return { eventId: row.eventId, threadBindingId: row.threadBindingId, inserted: false };
}

async function cancelClaimedOutbound(
  client: DatabaseExecutor,
  tenantId: string,
  outboundId: string,
  workerId: string
): Promise<boolean> {
  const cancelled = await client.query<{ messageId: string }>(
    `update channel_runtime.outbound_messages
     set status = 'cancelled', locked_at = null, locked_by = null,
         last_error_code = 'outbound_source_state_changed', last_error_message = null,
         updated_at = now()
     where tenant_id = $1 and id = $2 and status = 'processing' and locked_by = $3
     returning message_id as "messageId"`,
    [tenantId, outboundId, workerId]
  );
  const messageId = cancelled.rows[0]?.messageId;
  if (!messageId) return false;
  await client.query(
    `update pulso_iris.messages
     set delivery_status = case
           when delivery_status in ('delivered', 'read') then delivery_status
           else 'failed'
         end
     where tenant_id = $1 and id = $2`,
    [tenantId, messageId]
  );
  return true;
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
    const existing = await client.query<{ id: string; phoneHash: string }>(
      `select id, phone_e164_hash as "phoneHash"
       from channel_runtime.thread_bindings
       where tenant_id = $1 and provider = $2
          and (external_thread_id = $3 or phone_e164_hash = $4)
       for update`,
      [message.tenantId, message.provider, message.providerAddress, message.phoneHash]
    );
    if (existing.rows.length !== 1 || existing.rows[0]?.phoneHash !== message.phoneHash) {
      throw new Error("WhatsApp thread identity conflict");
    }
    id = existing.rows[0].id;
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

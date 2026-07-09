import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("012 WhatsApp and SOFIA durable runtime migration", () => {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  let tenantA = "";
  let tenantB = "";
  let connectionA = "";
  let bindingA = "";
  let conversationA = "";
  let inboundA = "";
  let messageA = "";
  let savepoint = 0;

  beforeAll(async () => {
    await client.connect();
    await client.query("begin");

    const tenants = await client.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name)
       values ($1, 'Channel runtime tenant A'), ($2, 'Channel runtime tenant B')
       returning id`,
      [`channel-runtime-a-${Date.now()}`, `channel-runtime-b-${Date.now()}`]
    );
    tenantA = tenants.rows[0]!.id;
    tenantB = tenants.rows[1]!.id;

    const patient = await client.query<{ id: string }>(
      `insert into pulso_iris.administrative_patients
         (tenant_id, preferred_channel, phone_e164_hash, phone_masked)
       values ($1, 'whatsapp', $2, '***0001') returning id`,
      [tenantA, "a".repeat(64)]
    );

    conversationA = (
      await client.query<{ id: string }>(
        `insert into pulso_iris.conversations (tenant_id, patient_id, channel)
         values ($1, $2, 'whatsapp') returning id`,
        [tenantA, patient.rows[0]!.id]
      )
    ).rows[0]!.id;

    connectionA = (
      await client.query<{ id: string }>(
        `insert into channel_runtime.connections (tenant_id, state)
         values ($1, 'ready') returning id`,
        [tenantA]
      )
    ).rows[0]!.id;

    bindingA = (
      await client.query<{ id: string }>(
        `insert into channel_runtime.thread_bindings
           (tenant_id, connection_id, provider, external_thread_id, phone_e164_hash,
            phone_masked, patient_id, conversation_id)
         values ($1, $2, 'whatsapp_web_test', 'control-a@s.whatsapp.net', $3,
                 '***0001', $4, $5)
         returning id`,
        [tenantA, connectionA, "a".repeat(64), patient.rows[0]!.id, conversationA]
      )
    ).rows[0]!.id;

    inboundA = (
      await client.query<{ id: string }>(
        `insert into channel_runtime.inbound_events
           (tenant_id, connection_id, thread_binding_id, provider,
            external_message_id, body, occurred_at)
         values ($1, $2, $3, 'whatsapp_web_test', 'inbound-control-1',
                 'Mensaje controlado', now())
         returning id`,
        [tenantA, connectionA, bindingA]
      )
    ).rows[0]!.id;

    messageA = (
      await client.query<{ id: string }>(
        `insert into pulso_iris.messages
           (tenant_id, conversation_id, sender, body, provider, external_message_id, delivery_status)
         values ($1, $2, 'patient', 'Mensaje controlado', 'whatsapp_web_test',
                 'inbound-control-1', 'received')
         returning id`,
        [tenantA, conversationA]
      )
    ).rows[0]!.id;

    await client.query(
      `update channel_runtime.inbound_events set message_id = $3
       where tenant_id = $1 and id = $2`,
      [tenantA, inboundA, messageA]
    );
  });

  afterAll(async () => {
    await client.query("rollback");
    await client.end();
  });

  async function expectDatabaseError(action: () => Promise<unknown>, code: string) {
    const name = `expected_error_${++savepoint}`;
    await client.query(`savepoint ${name}`);
    let caught: unknown;
    try {
      await action();
    } catch (error) {
      caught = error;
    }
    await client.query(`rollback to savepoint ${name}`);
    await client.query(`release savepoint ${name}`);
    expect(caught).toMatchObject({ code });
  }

  it("activates one tenant-scoped SOFIA prompt without storing provider secrets", async () => {
    const result = await client.query<{
      agentStatus: string;
      channelProvider: string;
      agendaProvider: string;
      promptStatus: string;
      systemPrompt: string;
      urgentMessage: string;
    }>(
      `select a.status as "agentStatus",
              a.runtime_config ->> 'channelProvider' as "channelProvider",
              a.runtime_config ->> 'agendaProvider' as "agendaProvider",
              f.status as "promptStatus",
              f.definition ->> 'systemPrompt' as "systemPrompt",
              f.definition ->> 'urgentMessage' as "urgentMessage"
       from platform.tenants t
       join platform.agents a on a.tenant_id = t.id and a.code = 'SOFIA'
       join platform.prompt_flows f on f.tenant_id = t.id and f.agent_id = a.id and f.status = 'active'
       where t.slug = 'cedco'`
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual(
      expect.objectContaining({
        agentStatus: "active",
        channelProvider: "whatsapp_web_test",
        agendaProvider: "internal",
        promptStatus: "active"
      })
    );
    expect(result.rows[0]!.systemPrompt).toContain("confirmacion explicita");
    expect(result.rows[0]!.systemPrompt).toContain("nunca inventes disponibilidad");
    expect(result.rows[0]!.urgentMessage).toContain("atencion medica urgente");

    const serialized = JSON.stringify(result.rows[0]);
    expect(serialized).not.toMatch(/api[_-]?key|password|secret/i);
  });

  it("keeps pilot professionals explicit and off by default", async () => {
    const result = await client.query<{ isPilot: boolean }>(
      `insert into pulso_iris.professionals (tenant_id, name, professional_type)
       values ($1, 'Controlled pilot candidate', 'optometrist')
       returning is_pilot as "isPilot"`,
      [tenantA]
    );

    expect(result.rows[0]?.isPilot).toBe(false);
  });

  it("rejects cross-tenant channel relationships", async () => {
    await expectDatabaseError(
      () =>
        client.query(
          `insert into channel_runtime.thread_bindings
             (tenant_id, connection_id, provider, external_thread_id, phone_e164_hash, phone_masked)
           values ($1, $2, 'whatsapp_web_test', 'cross-tenant@s.whatsapp.net', $3, '***0002')`,
          [tenantB, connectionA, "b".repeat(64)]
        ),
      "23503"
    );
  });

  it("deduplicates inbound events and persisted conversation messages", async () => {
    await expectDatabaseError(
      () =>
        client.query(
          `insert into channel_runtime.inbound_events
             (tenant_id, connection_id, provider, external_message_id, body, occurred_at)
           values ($1, $2, 'whatsapp_web_test', 'inbound-control-1', 'Reentrega', now())`,
          [tenantA, connectionA]
        ),
      "23505"
    );

    await expectDatabaseError(
      () =>
        client.query(
          `insert into pulso_iris.messages
             (tenant_id, conversation_id, sender, body, provider, external_message_id)
           values ($1, $2, 'patient', 'Reentrega', 'whatsapp_web_test', 'inbound-control-1')`,
          [tenantA, conversationA]
        ),
      "23505"
    );
  });

  it("claims inbound work atomically and records bounded attempts", async () => {
    const claimed = await client.query<{ id: string; status: string; attempts: number; worker: string }>(
      `select id, status, attempt_count as attempts, locked_by as worker
       from channel_runtime.claim_next_inbound_event('channel-worker-control')`
    );

    expect(claimed.rows).toEqual([
      expect.objectContaining({
        id: inboundA,
        status: "processing",
        attempts: 1,
        worker: "channel-worker-control"
      })
    ]);

    await client.query(
      `update channel_runtime.inbound_events
       set locked_at = now() - interval '3 minutes'
       where tenant_id = $1 and id = $2`,
      [tenantA, inboundA]
    );
    const recovered = await client.query<{ id: string; status: string; attempts: number }>(
      `select id, status, attempt_count as attempts
       from channel_runtime.claim_next_inbound_event('channel-worker-recovery')`
    );
    expect(recovered.rows[0]).toEqual({ id: inboundA, status: "processing", attempts: 2 });
  });

  it("deduplicates the outbound outbox and claims a single delivery", async () => {
    const sofiaMessage = await client.query<{ id: string }>(
      `insert into pulso_iris.messages
         (tenant_id, conversation_id, sender, body, provider, delivery_status)
       values ($1, $2, 'sofia', 'Respuesta controlada', 'whatsapp_web_test', 'queued')
       returning id`,
      [tenantA, conversationA]
    );

    const outbound = await client.query<{ id: string }>(
      `insert into channel_runtime.outbound_messages
         (tenant_id, connection_id, thread_binding_id, message_id, provider,
          idempotency_key, body)
       values ($1, $2, $3, $4, 'whatsapp_web_test', 'outbound-control-1',
               'Respuesta controlada') returning id`,
      [tenantA, connectionA, bindingA, sofiaMessage.rows[0]!.id]
    );

    await expectDatabaseError(
      () =>
        client.query(
          `insert into channel_runtime.outbound_messages
             (tenant_id, connection_id, thread_binding_id, message_id, provider,
              idempotency_key, body)
           values ($1, $2, $3, $4, 'whatsapp_web_test', 'outbound-control-1',
                   'Respuesta duplicada')`,
          [tenantA, connectionA, bindingA, sofiaMessage.rows[0]!.id]
        ),
      "23505"
    );

    const claimed = await client.query<{ id: string; status: string; attempts: number }>(
      `select id, status, attempt_count as attempts
       from channel_runtime.claim_next_outbound_message('outbound-worker-control')`
    );
    expect(claimed.rows[0]).toEqual({ id: outbound.rows[0]!.id, status: "processing", attempts: 1 });

    await client.query(
      `update channel_runtime.outbound_messages
       set locked_at = now() - interval '3 minutes'
       where tenant_id = $1 and id = $2`,
      [tenantA, outbound.rows[0]!.id]
    );
    const recovered = await client.query<{ id: string; attempts: number }>(
      `select id, attempt_count as attempts
       from channel_runtime.claim_next_outbound_message('outbound-worker-recovery')`
    );
    expect(recovered.rows[0]).toEqual({ id: outbound.rows[0]!.id, attempts: 2 });
    await client.query(
      `update channel_runtime.outbound_messages
       set status = 'sending', locked_at = now() - interval '3 minutes'
       where tenant_id = $1 and id = $2`,
      [tenantA, outbound.rows[0]!.id]
    );
    const mustNotResend = await client.query<{ id: string }>(
      `select id from channel_runtime.claim_next_outbound_message('outbound-worker-must-not-resend')`
    );
    expect(mustNotResend.rows).toEqual([]);
    const reconciliation = await client.query<{ status: string; errorCode: string; deliveryStatus: string }>(
      `select o.status, o.last_error_code as "errorCode", m.delivery_status as "deliveryStatus"
       from channel_runtime.outbound_messages o
       join pulso_iris.messages m on m.tenant_id = o.tenant_id and m.id = o.message_id
       where o.tenant_id = $1 and o.id = $2`,
      [tenantA, outbound.rows[0]!.id]
    );
    expect(reconciliation.rows[0]).toEqual({
      status: "reconciliation_required",
      errorCode: "delivery_outcome_unknown",
      deliveryStatus: "failed"
    });
  });

  it("queues one SOFIA job per inbound event and stores metrics without prompts or reasoning", async () => {
    const job = await client.query<{ id: string }>(
      `insert into agent_runtime.jobs
         (tenant_id, conversation_id, inbound_event_id, idempotency_key)
       values ($1, $2, $3, 'sofia-job-control-1') returning id`,
      [tenantA, conversationA, inboundA]
    );

    await expectDatabaseError(
      () =>
        client.query(
          `insert into agent_runtime.jobs
             (tenant_id, conversation_id, inbound_event_id, idempotency_key)
           values ($1, $2, $3, 'sofia-job-control-2')`,
          [tenantA, conversationA, inboundA]
        ),
      "23505"
    );

    const claimed = await client.query<{ id: string; status: string; attempts: number }>(
      `select id, status, attempt_count as attempts
       from agent_runtime.claim_next_job('agent-worker-control')`
    );
    expect(claimed.rows[0]).toEqual({ id: job.rows[0]!.id, status: "running", attempts: 1 });

    await client.query(
      `update agent_runtime.jobs set locked_at = now() - interval '3 minutes'
       where tenant_id = $1 and id = $2`,
      [tenantA, job.rows[0]!.id]
    );
    const recovered = await client.query<{ id: string; attempts: number }>(
      `select id, attempt_count as attempts
       from agent_runtime.claim_next_job('agent-worker-recovery')`
    );
    expect(recovered.rows[0]).toEqual({ id: job.rows[0]!.id, attempts: 2 });

    await client.query(
      `insert into agent_runtime.executions
         (tenant_id, job_id, provider, model, status, latency_ms,
          input_tokens, output_tokens, tool_names)
       values ($1, $2, 'controlled', 'controlled-model', 'completed', 25, 10, 5,
               '["get_catalog"]'::jsonb)`,
      [tenantA, job.rows[0]!.id]
    );

    const forbidden = await client.query<{ columnName: string }>(
      `select column_name as "columnName"
       from information_schema.columns
       where table_schema = 'agent_runtime'
         and table_name = 'executions'
         and column_name in ('prompt', 'response', 'reasoning', 'chain_of_thought', 'api_key')`
    );
    expect(forbidden.rows).toEqual([]);
  });
});

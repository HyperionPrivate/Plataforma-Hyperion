import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { receiveInternalAuditEvent, type InternalAuditEventEnvelope } from "./event-inbox.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("provider-owned durable Audit persistence", () => {
  let db: DatabaseClient;
  const tenantId = randomUUID();

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL ?? "");
  });

  afterAll(async () => {
    // Runtime is append-only by design; test rows live only in the disposable
    // logical database created by CI and are removed with that database.
    await db.close();
  });

  it("appends the ledger exactly once for an at-least-once event", async () => {
    const jobId = randomUUID();
    const event: InternalAuditEventEnvelope = {
      id: randomUUID(),
      type: "sofia.audit.event.record.v1",
      version: 1,
      occurredAt: "2026-07-13T15:10:00.000Z",
      tenantId,
      sourceService: "sofia-automation",
      payload: {
        tenantId,
        actorId: "agent:SOFIA",
        eventType: "agent.job.queued",
        entityType: "agent_job",
        entityId: jobId,
        metadata: { sourceEventType: "pulso.message.received.v1" }
      }
    };

    const accepted = await receiveInternalAuditEvent(db, event);
    const duplicate = await receiveInternalAuditEvent(db, event);
    const counts = await db.query<{ inbox: number; audit: number }>(
      `select
         (select count(*)::int from audit_runtime.inbox_events where tenant_id = $1) as inbox,
         (select count(*)::int from platform.audit_events where tenant_id = $1 and source_event_id = $2) as audit`,
      [tenantId, event.id]
    );

    expect(accepted.status).toBe("accepted");
    expect(duplicate).toEqual({ status: "duplicate", eventId: event.id });
    expect(counts.rows[0]).toEqual({ inbox: 1, audit: 1 });
  });

  it("accepts the NOVA-owned contract exactly once in the real Audit schema", async () => {
    const event: InternalAuditEventEnvelope = {
      id: randomUUID(),
      type: "nova.audit.event.record.v1",
      version: 1,
      occurredAt: "2026-07-18T17:00:00.000Z",
      tenantId,
      sourceService: "nova-core-service",
      payload: {
        tenantId,
        actorId: "operator:test",
        eventType: "nova.campaign.updated",
        entityType: "campaign",
        entityId: randomUUID(),
        metadata: { source: "nova-provider-integration" }
      }
    };

    const accepted = await receiveInternalAuditEvent(db, event);
    const duplicate = await receiveInternalAuditEvent(db, event);
    const persisted = await db.query<{ source_service: string; event_type: string; audit_count: number }>(
      `select inbox.source_service, inbox.event_type,
              (select count(*)::int from platform.audit_events audit
                where audit.source_event_id = inbox.event_id) as audit_count
         from audit_runtime.inbox_events inbox
        where inbox.event_id = $1::uuid`,
      [event.id]
    );

    expect(accepted.status).toBe("accepted");
    expect(duplicate).toEqual({ status: "duplicate", eventId: event.id });
    expect(persisted.rows[0]).toEqual({
      source_service: "nova-core-service",
      event_type: "nova.audit.event.record.v1",
      audit_count: 1
    });
  });
});

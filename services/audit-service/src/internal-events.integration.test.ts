import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { receiveInternalAuditEvent, type InternalAuditEventEnvelope } from "./event-inbox.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("durable SOFIA -> Audit persistence", () => {
  let db: DatabaseClient;
  let tenantId = "";

  beforeAll(async () => {
    db = createDatabase(TEST_DATABASE_URL ?? "");
    const tenant = await db.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name)
       values ($1, 'Autonomous audit flow test') returning id`,
      [`autonomous-audit-${randomUUID()}`]
    );
    tenantId = tenant.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await db.query("delete from audit_runtime.inbox_events where tenant_id = $1", [tenantId]);
      await db.query("delete from platform.audit_events where tenant_id = $1", [tenantId]);
      await db.query("delete from platform.tenants where id = $1", [tenantId]);
    }
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
});

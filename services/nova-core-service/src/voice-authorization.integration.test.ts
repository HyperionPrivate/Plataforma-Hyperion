import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { authorizeVoiceCall } from "./voice-authorization.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("voice authorization PostgreSQL boundary", () => {
  let db: DatabaseClient;
  const tenantId = randomUUID();
  const contactId = randomUUID();

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    const hash = createHash("sha256").update(tenantId).digest("hex");
    await db.query(
      `insert into nova.tenant_snapshots
         (tenant_id, status, display_name, source_version, source_updated_at, payload_hash)
       values ($1, 'active', 'Voice authorization integration', 1, now(), $2)`,
      [tenantId, hash]
    );
    await db.query(
      `insert into nova.contacts (tenant_id, contact_id, phone_e164, full_name, agency_code)
       values ($1, $2, '+573001234567', 'Prueba Integración', 'BGA')`,
      [tenantId, contactId]
    );
    await db.query(
      `insert into nova.compliance_settings (
         tenant_id, window_start_hour, window_end_hour, time_zone, allowed_weekdays,
         voice_enabled, whatsapp_enabled, max_attempts_per_day, max_attempts_per_contact,
         rolling_window_days, max_concurrent_calls, min_hours_between_attempts, respect_holidays
       ) values ($1, 8, 19, 'America/Bogota', array[1,2,3,4,5,6]::smallint[],
                 true, true, 2, 4, 7, 10, 4, true)`,
      [tenantId]
    );
  });

  afterAll(async () => {
    await db.query(`delete from nova.outbox_dlq where tenant_id = $1`, [tenantId]);
    await db.query(`delete from nova.outbox_events where tenant_id = $1`, [tenantId]);
    await db.query(`delete from nova.tenant_snapshots where tenant_id = $1`, [tenantId]);
    await db.close();
  });

  it("commits one attempt and one call request, then blocks a concurrent-frequency retry", async () => {
    const first = await db.transaction((tx) =>
      authorizeVoiceCall(tx, {
        tenantId,
        contactId,
        productFlow: "renovacion",
        voiceDestination: "http://voice.test/internal/events",
        auditDestination: "http://audit.test/internal/events",
        at: new Date("2026-07-21T15:00:00.000Z")
      })
    );
    expect(first.status).toBe("authorized");

    const second = await db.transaction((tx) =>
      authorizeVoiceCall(tx, {
        tenantId,
        contactId,
        productFlow: "renovacion",
        voiceDestination: "http://voice.test/internal/events",
        auditDestination: "http://audit.test/internal/events",
        at: new Date("2026-07-21T16:00:00.000Z")
      })
    );
    expect(second.status).toBe("blocked");
    if (second.status === "blocked") expect(second.snapshot.decision.reason).toBe("min_hours_between_attempts");

    const attempts = await db.query<{ count: string }>(
      `select count(*)::text as count from nova.contact_attempts where tenant_id = $1 and contact_id = $2`,
      [tenantId, contactId]
    );
    const requests = await db.query<{ count: string }>(
      `select count(*)::text as count from nova.outbox_events
        where tenant_id = $1 and event_type = 'voice.call.requested.v2'`,
      [tenantId]
    );
    expect(Number(attempts.rows[0]?.count)).toBe(1);
    expect(Number(requests.rows[0]?.count)).toBe(1);
  });
});

import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { lumenProjectionEventSchema, type LumenProjectionEvent } from "@hyperion/lumen-contracts";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consumeLumenProjectionEvent, sha256CanonicalJson } from "./projection-events.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_LUMEN_FIXTURE_DATABASE_URL = process.env.TEST_LUMEN_FIXTURE_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL && TEST_LUMEN_FIXTURE_DATABASE_URL ? describe : describe.skip;
type TenantSnapshotEvent = Extract<LumenProjectionEvent, { type: "access.lumen.tenant-snapshot.v1" }>;
type OperatorGrantEvent = Extract<LumenProjectionEvent, { type: "access.lumen.operator-grant.v1" }>;
type EncounterReferenceEvent = Extract<LumenProjectionEvent, { type: "pulso.lumen.encounter-reference.v1" }>;

describeIntegration("LUMEN autonomous projection persistence", () => {
  let db: DatabaseClient;
  let fixtureDb: DatabaseClient;
  const tenantId = randomUUID();
  const operatorId = randomUUID();
  const encounterId = randomUUID();
  const patientId = randomUUID();
  const professionalId = randomUUID();
  const siteId = randomUUID();

  beforeAll(() => {
    db = createDatabase(TEST_DATABASE_URL ?? "");
    fixtureDb = createDatabase(TEST_LUMEN_FIXTURE_DATABASE_URL ?? "");
  });

  afterAll(async () => {
    await Promise.all([db.close(), fixtureDb.close()]);
  });

  it("handles accepted, replay, stale and contradictory source versions deterministically", async () => {
    const tenant = tenantEvent({ sourceVersion: 10 });
    await expect(consumeLumenProjectionEvent(db, tenant)).resolves.toEqual({
      status: "accepted",
      projection: "tenant_snapshot"
    });
    await expect(consumeLumenProjectionEvent(db, tenant)).resolves.toEqual({
      status: "duplicate",
      projection: "tenant_snapshot"
    });
    await expect(
      consumeLumenProjectionEvent(db, {
        ...tenant,
        payload: { ...tenant.payload, isDemo: false }
      })
    ).resolves.toEqual({ status: "conflict", reason: "event_id" });

    await expect(
      consumeLumenProjectionEvent(db, tenantEvent({ id: randomUUID(), sourceVersion: 9, isDemo: false }))
    ).resolves.toEqual({ status: "stale", projection: "tenant_snapshot" });
    await expect(
      consumeLumenProjectionEvent(db, tenantEvent({ id: randomUUID(), sourceVersion: 10, isDemo: false }))
    ).resolves.toEqual({ status: "conflict", projection: "tenant_snapshot", reason: "source_version" });
    await expect(
      consumeLumenProjectionEvent(db, tenantEvent({ id: randomUUID(), sourceVersion: 11 }))
    ).resolves.toEqual({ status: "accepted", projection: "tenant_snapshot" });

    const stored = await db.query<{ sourceVersion: string; isDemo: boolean }>(
      `select source_version::text as "sourceVersion", is_demo as "isDemo"
       from lumen.tenant_snapshots where tenant_id = $1`,
      [tenantId]
    );
    expect(stored.rows[0]).toEqual({ sourceVersion: "11", isDemo: true });
  });

  it("persists grants and reference snapshots without Access or PULSO table reads", async () => {
    const operator = operatorEvent();
    await expect(consumeLumenProjectionEvent(db, operator)).resolves.toEqual({
      status: "accepted",
      projection: "operator_grant"
    });
    await expect(consumeLumenProjectionEvent(db, operator)).resolves.toEqual({
      status: "duplicate",
      projection: "operator_grant"
    });

    const revoked = operatorEvent({ id: randomUUID(), sourceVersion: 2, isActive: false, canReview: false });
    await expect(consumeLumenProjectionEvent(db, revoked)).resolves.toEqual({
      status: "accepted",
      projection: "operator_grant"
    });
    await expect(
      consumeLumenProjectionEvent(
        db,
        operatorEvent({ id: randomUUID(), sourceVersion: 1, isActive: true, canReview: true })
      )
    ).resolves.toEqual({ status: "stale", projection: "operator_grant" });
    await expect(
      consumeLumenProjectionEvent(
        db,
        operatorEvent({ id: randomUUID(), sourceVersion: 3, isActive: true, canReview: false })
      )
    ).resolves.toEqual({ status: "accepted", projection: "operator_grant" });
    await expect(
      consumeLumenProjectionEvent(
        db,
        operatorEvent({ id: randomUUID(), sourceVersion: 4, isActive: true, canReview: true })
      )
    ).resolves.toEqual({ status: "accepted", projection: "operator_grant" });

    const storedGrant = await db.query<{ sourceVersion: string; isActive: boolean; canReview: boolean }>(
      `select source_version::text as "sourceVersion", is_active as "isActive", can_review as "canReview"
       from lumen.operator_grants where tenant_id = $1 and operator_id = $2`,
      [tenantId, operatorId]
    );
    expect(storedGrant.rows[0]).toEqual({ sourceVersion: "4", isActive: true, canReview: true });

    const reference = referenceEvent({ sourceVersion: 20 });
    await expect(consumeLumenProjectionEvent(db, reference)).resolves.toEqual({
      status: "accepted",
      projection: "encounter_reference"
    });
    await expect(
      consumeLumenProjectionEvent(db, referenceEvent({ id: randomUUID(), sourceVersion: 20 }))
    ).resolves.toEqual({ status: "duplicate", projection: "encounter_reference" });
    await expect(
      consumeLumenProjectionEvent(db, referenceEvent({ id: randomUUID(), sourceVersion: 19, patientAge: 55 }))
    ).resolves.toEqual({ status: "stale", projection: "encounter_reference" });
    await expect(
      consumeLumenProjectionEvent(db, referenceEvent({ id: randomUUID(), sourceVersion: 20, patientAge: 55 }))
    ).resolves.toEqual({ status: "conflict", projection: "encounter_reference", reason: "source_version" });

    const snapshot = await db.query<{ patientDisplayName: string; sourceVersion: string }>(
      `select patient_display_name as "patientDisplayName", source_version::text as "sourceVersion"
       from lumen.encounter_reference_snapshots where tenant_id = $1 and encounter_id = $2`,
      [tenantId, encounterId]
    );
    expect(snapshot.rows[0]).toEqual({ patientDisplayName: "Paciente sintético", sourceVersion: "20" });
  });

  it("rolls back the inbox claim when a dependent projection cannot be persisted", async () => {
    const event = operatorEvent({ id: randomUUID(), tenantId: randomUUID(), operatorId: randomUUID() });
    await expect(consumeLumenProjectionEvent(db, event)).rejects.toBeTruthy();
    const inbox = await db.query<{ count: number }>(
      `select count(*)::int as count from lumen.inbox_events where id = $1`,
      [event.id]
    );
    expect(inbox.rows[0]?.count).toBe(0);
  });

  it("serializes concurrent first writes and preserves the greatest source version and hash", async () => {
    const concurrentTenantId = randomUUID();
    const createConcurrentEvent = (sourceVersion: number): LumenProjectionEvent =>
      parseEvent({
        id: randomUUID(),
        type: "access.lumen.tenant-snapshot.v1",
        version: 1,
        occurredAt: "2026-07-13T15:03:00.000Z",
        tenantId: concurrentTenantId,
        payload: {
          tenantId: concurrentTenantId,
          status: sourceVersion === 101 ? "active" : "paused",
          isDemo: true,
          sourceVersion,
          sourceUpdatedAt: "2026-07-13T15:02:30.000Z"
        }
      });
    const lower = createConcurrentEvent(100);
    const greater = createConcurrentEvent(101);

    const outcomes = await Promise.all([
      consumeLumenProjectionEvent(db, lower),
      consumeLumenProjectionEvent(db, greater)
    ]);
    expect(outcomes.some((outcome) => outcome.status === "accepted")).toBe(true);
    expect(outcomes.every((outcome) => outcome.status === "accepted" || outcome.status === "stale")).toBe(true);

    const stored = await db.query<{ sourceVersion: string; payloadHash: string }>(
      `select source_version::text as "sourceVersion", payload_hash as "payloadHash"
       from lumen.tenant_snapshots where tenant_id = $1`,
      [concurrentTenantId]
    );
    expect(stored.rows[0]).toEqual({
      sourceVersion: "101",
      payloadHash: sha256CanonicalJson(greater.payload)
    });
  });

  it("terminates newer reference changes after clinical approval freezes the snapshot", async () => {
    await fixtureDb.query(
      `insert into lumen.encounters (
         id, tenant_id, patient_id, professional_id, site_id, scheduled_at,
         status, is_demo, demo_key, metadata
       ) values ($1, $2, $3, $4, $5, now(), 'preconsultation', true, $6, '{"synthetic":true}'::jsonb)`,
      [encounterId, tenantId, patientId, professionalId, siteId, `projection-${encounterId}`]
    );
    const dictation = await fixtureDb.query<{ id: string }>(
      `insert into lumen.dictations (
         tenant_id, encounter_id, status, transcript, mime_type, provider,
         metadata, reviewed_at, reviewed_by
       ) values ($1, $2, 'transcribed', 'Contenido sintético revisado', 'text/plain', 'manual',
                 '{"audioStored":false,"source":"manual_entry"}'::jsonb, now(), $3)
       returning id`,
      [tenantId, encounterId, operatorId]
    );
    const record = await fixtureDb.query<{ id: string }>(
      `insert into lumen.clinical_records (
         tenant_id, encounter_id, dictation_id, status, content, provider, model
       ) values ($1, $2, $3, 'draft', $4::jsonb, 'manual', 'manual')
       returning id`,
      [
        tenantId,
        encounterId,
        dictation.rows[0]!.id,
        JSON.stringify({ reasonForVisit: "Control sintético", uncertainties: [] })
      ]
    );
    await fixtureDb.query(`update lumen.encounters set status = 'review' where tenant_id = $1 and id = $2`, [
      tenantId,
      encounterId
    ]);
    await fixtureDb.query(
      `update lumen.clinical_records
       set status = 'approved', approved_by = $3, approved_at = now(), updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, record.rows[0]!.id, operatorId]
    );

    const newer = referenceEvent({
      id: randomUUID(),
      sourceVersion: 21,
      patientDisplayName: "Cambio posterior prohibido"
    });
    await expect(consumeLumenProjectionEvent(db, newer)).resolves.toEqual({
      status: "frozen",
      projection: "encounter_reference"
    });
    await expect(consumeLumenProjectionEvent(db, newer)).resolves.toEqual({
      status: "frozen",
      projection: "encounter_reference"
    });
  });

  function tenantEvent(
    override: Partial<{ id: string; sourceVersion: number; isDemo: boolean }> = {}
  ): TenantSnapshotEvent {
    return parseEvent({
      id: override.id ?? randomUUID(),
      type: "access.lumen.tenant-snapshot.v1",
      version: 1,
      occurredAt: "2026-07-13T15:00:00.000Z",
      tenantId,
      payload: {
        tenantId,
        status: "active",
        isDemo: override.isDemo ?? true,
        sourceVersion: override.sourceVersion ?? 10,
        sourceUpdatedAt: "2026-07-13T14:59:00.000Z"
      }
    }) as TenantSnapshotEvent;
  }

  function operatorEvent(
    override: Partial<{
      id: string;
      tenantId: string;
      operatorId: string;
      sourceVersion: number;
      isActive: boolean;
      canReview: boolean;
    }> = {}
  ): OperatorGrantEvent {
    const eventTenantId = override.tenantId ?? tenantId;
    return parseEvent({
      id: override.id ?? randomUUID(),
      type: "access.lumen.operator-grant.v1",
      version: 1,
      occurredAt: "2026-07-13T15:01:00.000Z",
      tenantId: eventTenantId,
      payload: {
        tenantId: eventTenantId,
        operatorId: override.operatorId ?? operatorId,
        role: "advisor",
        isActive: override.isActive ?? true,
        canReview: override.canReview ?? true,
        sourceVersion: override.sourceVersion ?? 1,
        sourceUpdatedAt: "2026-07-13T15:00:30.000Z"
      }
    }) as OperatorGrantEvent;
  }

  function referenceEvent(
    override: Partial<{
      id: string;
      sourceVersion: number;
      patientAge: number;
      patientDisplayName: string;
    }> = {}
  ): EncounterReferenceEvent {
    return parseEvent({
      id: override.id ?? randomUUID(),
      type: "pulso.lumen.encounter-reference.v1",
      version: 1,
      occurredAt: "2026-07-13T15:02:00.000Z",
      tenantId,
      payload: {
        tenantId,
        encounterId,
        patientId,
        siteId,
        professionalId,
        patientDisplayName: override.patientDisplayName ?? "Paciente sintético",
        patientAge: override.patientAge ?? 54,
        payer: null,
        documentMasked: null,
        professionalName: "Profesional sintético",
        subspecialty: "Oftalmología",
        siteName: "Sede sintética",
        patientIsDemo: true,
        professionalIsDemo: true,
        sourceVersion: override.sourceVersion ?? 20,
        sourceUpdatedAt: "2026-07-13T15:01:30.000Z"
      }
    }) as EncounterReferenceEvent;
  }
});

function parseEvent(value: unknown): LumenProjectionEvent {
  return lumenProjectionEventSchema.parse(value);
}

import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";
import {
  acquireAudioCleanupOwnerLease,
  readLumenAudioCleanupConfiguration,
  startLumenAudioCleanupReconciler
} from "./audio-cleanup-recovery.js";
import { temporaryAudioRequestDirectory } from "./temporary-audio.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_LUMEN_FIXTURE_DATABASE_URL = process.env.TEST_LUMEN_FIXTURE_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL && TEST_LUMEN_FIXTURE_DATABASE_URL ? describe : describe.skip;
const { Client } = pg;

describeIntegration("LUMEN audio cleanup lease readiness", () => {
  const owner = `lumen-readiness-${randomUUID()}`;
  let app: ServiceHandle["app"];
  let client: pg.Client;
  let fixtureClient: pg.Client;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.LUMEN_INSTANCE_ID = owner;
    process.env.DURABLE_OUTBOX_ENABLED = "false";
    client = new Client({ connectionString: TEST_DATABASE_URL });
    fixtureClient = new Client({ connectionString: TEST_LUMEN_FIXTURE_DATABASE_URL });
    await Promise.all([client.connect(), fixtureClient.connect()]);
    const handle = await createService({
      serviceName: "lumen-service",
      databaseRequired: true,
      registerRoutes
    });
    app = handle.app;
  });

  afterAll(async () => {
    await app?.close();
    await client?.query(`delete from lumen.audio_cleanup_owner_leases where cleanup_owner = $1`, [owner]);
    await Promise.all([client?.end(), fixtureClient?.end()]);
    delete process.env.DATABASE_URL;
    delete process.env.LUMEN_INSTANCE_ID;
    delete process.env.DURABLE_OUTBOX_ENABLED;
  });

  it("recovers interrupted work with the same stable owner after the crashed holder lease expires", async () => {
    const crashedOwner = `lumen-crash-recovery-${randomUUID()}`;
    const previousHolder = randomUUID();
    const removed: string[] = [];
    let reconciler: Awaited<ReturnType<typeof startLumenAudioCleanupReconciler>> | undefined;
    const fixture = await createCleanupFixture(fixtureClient, crashedOwner, "crash-recovery");
    try {
      await fixtureClient.query(
        `insert into lumen.audio_cleanup_owner_leases (
           cleanup_owner, holder_id, acquired_at, heartbeat_at, expires_at
         ) values ($1, $2, now() - interval '31 minutes', now() - interval '31 minutes', now() - interval '1 second')`,
        [crashedOwner, previousHolder]
      );

      const configuration = readLumenAudioCleanupConfiguration({
        NODE_ENV: "test",
        LUMEN_INSTANCE_ID: crashedOwner
      });
      reconciler = await startLumenAudioCleanupReconciler(client, configuration, {
        holderId: randomUUID(),
        removeDirectory: async (path) => {
          removed.push(path);
        }
      });

      const recovered = await client.query<{
        status: string;
        errorCode: string | null;
        deletedAt: Date | null;
      }>(
        `select status, error_code as "errorCode", temp_audio_deleted_at as "deletedAt"
           from lumen.processing_attempts where id = $1`,
        [fixture.attemptId]
      );
      expect(recovered.rows[0]).toMatchObject({ status: "failed", errorCode: "process_interrupted" });
      expect(recovered.rows[0]?.deletedAt).toBeInstanceOf(Date);
      expect(removed).toEqual([
        temporaryAudioRequestDirectory(configuration.rootDirectory, crashedOwner, fixture.attemptId).requestDirectory
      ]);
    } finally {
      await reconciler?.stop();
      await fixtureClient.query(`delete from lumen.audio_cleanup_owner_leases where cleanup_owner = $1`, [
        crashedOwner
      ]);
      await deleteCleanupFixture(fixtureClient, fixture);
    }
  });

  it("returns HTTP 503 for expired foreign-owner work and recovers when that owner lease is restored", async () => {
    const foreignOwner = `lumen-foreign-recovery-${randomUUID()}`;
    const foreignHolder = randomUUID();
    const fixture = await createCleanupFixture(fixtureClient, foreignOwner, "foreign-owner");
    try {
      await fixtureClient.query(
        `insert into lumen.audio_cleanup_owner_leases (
           cleanup_owner, holder_id, acquired_at, heartbeat_at, expires_at
         ) values ($1, $2, now() - interval '31 minutes', now() - interval '31 minutes', now() - interval '1 second')`,
        [foreignOwner, foreignHolder]
      );

      const orphaned = await app.inject({ method: "GET", url: "/ready" });
      expect(orphaned.statusCode).toBe(503);
      expect(orphaned.json().dependencies).toContainEqual({
        name: "lumen_audio_cleanup_lease",
        status: "down",
        detail: "dependency readiness check failed"
      });

      await fixtureClient.query(
        `update lumen.audio_cleanup_owner_leases
            set heartbeat_at = now(), expires_at = now() + interval '30 minutes'
          where cleanup_owner = $1 and holder_id = $2`,
        [foreignOwner, foreignHolder]
      );
      const restored = await app.inject({ method: "GET", url: "/ready" });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().dependencies).toContainEqual({ name: "lumen_audio_cleanup_lease", status: "ok" });
    } finally {
      await fixtureClient.query(`delete from lumen.audio_cleanup_owner_leases where cleanup_owner = $1`, [
        foreignOwner
      ]);
      await deleteCleanupFixture(fixtureClient, fixture);
    }
  });

  it("returns HTTP 503 after the durable owner lease is lost", async () => {
    const healthy = await app.inject({ method: "GET", url: "/ready" });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json().dependencies).toContainEqual({ name: "lumen_audio_cleanup_lease", status: "ok" });
    await expect(
      acquireAudioCleanupOwnerLease(client, { owner, holderId: randomUUID(), ttlMs: 30 * 60_000 })
    ).resolves.toBe(false);

    await client.query(`delete from lumen.audio_cleanup_owner_leases where cleanup_owner = $1`, [owner]);

    const unready = await app.inject({ method: "GET", url: "/ready" });
    expect(unready.statusCode).toBe(503);
    expect(unready.json().dependencies).toContainEqual({
      name: "lumen_audio_cleanup_lease",
      status: "down",
      detail: "dependency readiness check failed"
    });
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface CleanupFixture {
  readonly tenantId: string;
  readonly encounterId: string;
  readonly attemptId: string;
}

async function createCleanupFixture(client: pg.Client, cleanupOwner: string, label: string): Promise<CleanupFixture> {
  const tenantId = randomUUID();
  await client.query(
    `insert into lumen.tenant_snapshots (
       tenant_id, status, is_demo, is_active, source_version, source_updated_at, payload_hash
     ) values ($1, 'active', true, true, 1, now(), $2)`,
    [tenantId, sha256(`tenant:${tenantId}:1`)]
  );
  const encounterId = randomUUID();
  const patientId = randomUUID();
  const siteId = randomUUID();
  const professionalId = randomUUID();
  await client.query(
    `insert into lumen.encounter_reference_snapshots (
       tenant_id, encounter_id, patient_id, site_id, professional_id,
       patient_display_name, professional_name, site_name,
       patient_is_demo, professional_is_demo, source_version, source_updated_at, payload_hash
     ) values ($1, $2, $3, $4, $5, 'Paciente sintético', 'Profesional sintético',
               'Sede sintética', true, true, 1, now(), $6)`,
    [tenantId, encounterId, patientId, siteId, professionalId, sha256(`reference:${encounterId}:1`)]
  );
  await client.query(
    `insert into lumen.encounters (
       id, tenant_id, patient_id, professional_id, site_id, scheduled_at,
       is_demo, demo_key, metadata
     ) values ($1, $2, $3, $4, $5, now(), true, $6, '{"synthetic":true}'::jsonb)`,
    [encounterId, tenantId, patientId, professionalId, siteId, `${label}-${randomUUID()}`]
  );
  const attemptId = (
    await client.query<{ id: string }>(
      `insert into lumen.processing_attempts (
         tenant_id, encounter_id, operation, idempotency_key, input_sha256,
         provider, model, mime_type, source, duration_seconds, cleanup_protocol, cleanup_owner
       ) values ($1, $2, 'transcription', $3, $4, 'test-stt', 'test-model',
                 'audio/wav', 'authorized_upload', 8, 'deterministic_v2', $5)
       returning id`,
      [tenantId, encounterId, randomUUID(), sha256(`authorized synthetic audio:${label}`), cleanupOwner]
    )
  ).rows[0]!.id;
  return { tenantId, encounterId, attemptId };
}

async function deleteCleanupFixture(client: pg.Client, fixture: CleanupFixture): Promise<void> {
  // The immutable-attempt trigger permits removal only through the encounter's
  // cascading delete, preserving the same lifecycle used by production.
  await client.query(`delete from lumen.encounters where id = $1`, [fixture.encounterId]);
  await client.query(`delete from lumen.encounter_reference_snapshots where tenant_id = $1 and encounter_id = $2`, [
    fixture.tenantId,
    fixture.encounterId
  ]);
  await client.query(`delete from lumen.tenant_snapshots where tenant_id = $1`, [fixture.tenantId]);
}

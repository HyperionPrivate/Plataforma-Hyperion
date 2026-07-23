#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const docker = process.platform === "win32" ? "docker.exe" : "docker";
const pnpm = process.platform === "win32" ? "pnpm.exe" : "pnpm";
const postgresImage = "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const runIdPattern = /^[a-f0-9]{12}$/;
const containerPattern = /^hyperion-access-channel-acceptance-[a-f0-9]{12}$/;
const acceptanceLabel = "com.hyperion.acceptance=access-channel-projection";
const runLabelKey = "com.hyperion.acceptance.run-id";
const sourceClosurePaths = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "scripts/autonomy/access-channel-projection.e2e.mjs",
  "packages/access-migrations",
  "packages/config",
  "packages/database",
  "packages/durable-events",
  "packages/logger",
  "packages/platform-contracts",
  "packages/pulso-contracts",
  "packages/pulso-migrations",
  "packages/service-runtime",
  "services/identity-service",
  "services/whatsapp-channel-service"
];
const buildArtifactPaths = [
  "packages/access-migrations/dist",
  "packages/config/dist",
  "packages/database/dist",
  "packages/durable-events/dist",
  "packages/logger/dist",
  "packages/platform-contracts/dist",
  "packages/pulso-contracts/dist",
  "packages/pulso-migrations/dist",
  "packages/service-runtime/dist",
  "services/identity-service/dist",
  "services/whatsapp-channel-service/dist"
];
const closureExcludedDirectories = new Set(["node_modules", "dist", "coverage", ".turbo"]);
const allowedParentEnvironment = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "DOCKER_CONFIG",
  "DOCKER_CLI_PLUGIN_EXTRA_DIRS",
  "TEMP",
  "TMP",
  "LANG"
];

let activeChild;
let receivedSignal;

export function acceptanceNames(runId) {
  if (!runIdPattern.test(runId))
    throw new Error("Access→Channel acceptance run id must be 12 lowercase hex characters");
  const names = {
    container: `hyperion-access-channel-acceptance-${runId}`,
    accessDatabase: `access_acceptance_${runId}`,
    pulsoDatabase: `pulso_acceptance_${runId}`
  };
  if (!containerPattern.test(names.container)) throw new Error("Unsafe Access→Channel acceptance container name");
  return Object.freeze(names);
}

export function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Receipt contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Receipt contains a non-JSON value");
}

export function sealReceipt(receipt) {
  const receiptSha256 = sha256(canonicalJson(receipt));
  return Object.freeze({ ...receipt, receiptSha256 });
}

export async function runAccessChannelAcceptance(environment = process.env, options = {}) {
  if (environment.RUN_ACCESS_CHANNEL_ACCEPTANCE !== "1") {
    throw new Error("Set RUN_ACCESS_CHANNEL_ACCEPTANCE=1 to run the disposable Access→Channel acceptance");
  }

  const runId = randomBytes(6).toString("hex");
  const names = acceptanceNames(runId);
  const operationId = new Date().toISOString().replaceAll(/[-:.]/g, "").replace("T", "T").replace("Z", "Z");
  const tenantFixtures = [
    { tenantId: randomUUID(), status: "active", fixture: "lifecycle" },
    { tenantId: randomUUID(), status: "paused", fixture: "paused-parity" },
    { tenantId: randomUUID(), status: "archived", fixture: "archived-parity" }
  ];
  const tenantId = tenantFixtures[0].tenantId;
  const workerId = `access-channel-acceptance-${runId}`;
  const secrets = acceptanceSecrets();
  const inventoryBefore = await dockerInventory();
  let ownsContainer = false;
  let channelProcess;
  let identityDb;
  let accessFixtureDb;
  let pulsoFixtureDb;
  let channelDb;
  let acceptanceResult;
  let acceptanceError;
  let cleanupRemoval = { removedContainers: [], matchedByLabel: [] };
  const cleanupErrors = [];

  await assertContainerAbsent(names.container);
  await assertLabelNamespaceAbsent(runId);
  const source = await sourceEvidence();
  const toolchain = await toolchainEvidence();
  let postgresRuntime;
  let buildArtifacts;

  try {
    phase("starting an isolated PostgreSQL 16 cluster");
    // The exact namespace was proven absent above. Own it before creation so
    // an interrupt between Docker creating and returning cannot orphan it.
    ownsContainer = true;
    await run(docker, [
      "run",
      "--detach",
      "--name",
      names.container,
      "--label",
      acceptanceLabel,
      "--label",
      `${runLabelKey}=${runId}`,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_USER=${secrets.adminUser}`,
      "--env",
      `POSTGRES_PASSWORD=${secrets.adminPassword}`,
      "--env",
      "POSTGRES_DB=postgres",
      "--health-cmd",
      `pg_isready -U ${secrets.adminUser} -d postgres`,
      "--health-interval",
      "1s",
      "--health-timeout",
      "3s",
      "--health-retries",
      "30",
      postgresImage
    ]);
    await waitForHealthy(names.container);
    postgresRuntime = await postgresImageEvidence(names.container);
    const postgresPort = await publishedLoopbackPort(names.container);
    const adminUrl = databaseUrl(secrets.adminUser, secrets.adminPassword, postgresPort, "postgres");

    phase("building the exact provider and runtime closure");
    await run(pnpm, [
      "--filter",
      "@hyperion/access-migrations",
      "--filter",
      "@hyperion/pulso-migrations",
      "--filter",
      "@hyperion/identity-service...",
      "--filter",
      "@hyperion/whatsapp-channel-service...",
      "build"
    ]);
    buildArtifacts = await hashRepositoryClosure(buildArtifactPaths, { excludeGenerated: false });

    phase("bootstrapping two independent logical databases and runtime roles");
    const accessEnvironment = {
      ACCESS_POSTGRES_ADMIN_URL: adminUrl,
      ACCESS_POSTGRES_DB: names.accessDatabase,
      ACCESS_MIGRATOR_DATABASE_PASSWORD: secrets.accessMigrator,
      IDENTITY_DATABASE_PASSWORD: secrets.identity,
      TENANT_DATABASE_PASSWORD: secrets.tenant
    };
    await runPackage("@hyperion/access-migrations", "bootstrap:database", accessEnvironment);
    const accessMigratorUrl = databaseUrl(
      "hyperion_access_migrator",
      secrets.accessMigrator,
      postgresPort,
      names.accessDatabase
    );
    await runPackage("@hyperion/access-migrations", "migrate", {
      ...accessEnvironment,
      ACCESS_MIGRATOR_DATABASE_URL: accessMigratorUrl
    });
    await runPackage("@hyperion/access-migrations", "bootstrap:roles", accessEnvironment);

    const pulsoEnvironment = {
      PULSO_MIGRATION_PHASE: "contract",
      PULSO_POSTGRES_ADMIN_URL: adminUrl,
      PULSO_POSTGRES_DB: names.pulsoDatabase,
      PULSO_MIGRATOR_DATABASE_PASSWORD: secrets.pulsoMigrator,
      PULSO_DATABASE_PASSWORD: secrets.pulso,
      SOFIA_DATABASE_PASSWORD: secrets.sofia,
      KNOWLEDGE_DATABASE_PASSWORD: secrets.knowledge,
      INTEGRATION_DATABASE_PASSWORD: secrets.integration,
      CHANNEL_DATABASE_PASSWORD: secrets.channel
    };
    await runPackage("@hyperion/pulso-migrations", "bootstrap:database", pulsoEnvironment);
    const pulsoMigratorUrl = databaseUrl(
      "hyperion_pulso_migrator",
      secrets.pulsoMigrator,
      postgresPort,
      names.pulsoDatabase
    );
    await runPackage("@hyperion/pulso-migrations", "migrate", {
      ...pulsoEnvironment,
      PULSO_MIGRATOR_DATABASE_URL: pulsoMigratorUrl
    });
    await runPackage("@hyperion/pulso-migrations", "bootstrap:roles", pulsoEnvironment);

    const [{ createDatabase }, projections] = await Promise.all([
      import(pathToFileURL(path.join(repositoryRoot, "packages/database/dist/index.js")).href),
      import(
        pathToFileURL(path.join(repositoryRoot, "services/identity-service/dist/access-tenant-projections.js")).href
      )
    ]);
    const identityUrl = databaseUrl("hyperion_identity", secrets.identity, postgresPort, names.accessDatabase);
    const channelUrl = databaseUrl("hyperion_channel", secrets.channel, postgresPort, names.pulsoDatabase);
    identityDb = createDatabase(identityUrl);
    accessFixtureDb = createDatabase(accessMigratorUrl);
    pulsoFixtureDb = createDatabase(pulsoMigratorUrl);
    channelDb = createDatabase(channelUrl);

    for (const [index, tenant] of tenantFixtures.entries()) {
      await accessFixtureDb.query(
        `insert into platform.tenants (id, slug, display_name, status, metadata)
         values ($1, $2, $3, $4, jsonb_build_object('acceptance', true, 'fixture', $5::text))`,
        [
          tenant.tenantId,
          `access-channel-${runId}-${index + 1}`,
          `Access Channel parity ${index + 1}`,
          tenant.status,
          tenant.fixture
        ]
      );
    }

    const channelPort = await reserveLoopbackPort();
    const destination = `http://127.0.0.1:${channelPort}/internal/v1/events/access-tenant-snapshots`;
    const outbox = new projections.PostgresAccessTenantProjectionOutbox(identityDb, workerId, destination, true);
    const dispatcher = projections.createAccessTenantProjectionHttpDispatcher(
      outbox,
      workerId,
      new Map([[destination, secrets.edgeToken]])
    );

    phase("proving outage retry before the Channel process exists");
    assert.deepEqual(await projections.reconcileAccessTenantSnapshots(identityDb, 10), {
      candidatesProcessed: tenantFixtures.length,
      eventsEnqueued: tenantFixtures.length,
      hasMore: false
    });
    const initialEventsBeforeFailure = await Promise.all(
      tenantFixtures.map((tenant) => currentAccessEvent(accessFixtureDb, tenant.tenantId))
    );
    const activeBeforeFailure = initialEventsBeforeFailure[0];
    const failedDrain = await dispatcher.drainOnce();
    assert.deepEqual(pick(failedDrain, ["claimed", "completed", "failed"]), {
      claimed: tenantFixtures.length,
      completed: 0,
      failed: tenantFixtures.length
    });
    const initialEventsAfterFailure = await Promise.all(
      tenantFixtures.map((tenant) => currentAccessEvent(accessFixtureDb, tenant.tenantId))
    );
    for (const [index, event] of initialEventsAfterFailure.entries()) {
      const before = initialEventsBeforeFailure[index];
      assert.equal(event.eventId, before.eventId);
      assert.equal(event.payloadSha256, before.payloadSha256);
      assert.equal(event.sourceVersion, before.sourceVersion);
      assert.equal(event.status, "retry_scheduled");
    }
    await accessFixtureDb.query(
      "update access_runtime.tenant_projection_outbox set next_attempt_at = now() where id = any($1::uuid[])",
      [initialEventsBeforeFailure.map((event) => event.eventId)]
    );

    phase("starting the real WhatsApp Channel app on loopback TCP");
    channelProcess = startChannelProcess(channelPort, channelUrl, secrets.edgeToken);
    activeChild = channelProcess;
    await waitForHttp(`http://127.0.0.1:${channelPort}/ready`, channelProcess);

    const activeEnvelope = activeBeforeFailure.envelope;
    const auth = {
      unauthenticatedStatus: await postStatus(destination, activeEnvelope),
      wrongTokenStatus: await postStatus(destination, activeEnvelope, workloadHeaders(`wrong-${secrets.edgeToken}`)),
      forbiddenCallerStatus: await postStatus(destination, activeEnvelope, {
        authorization: `Bearer ${secrets.edgeToken}`,
        "x-hyperion-caller": "nova-core-service"
      }),
      malformedBodyStatus: await postStatus(destination, { invalid: true }, workloadHeaders(secrets.edgeToken))
    };
    assert.deepEqual(auth, {
      unauthenticatedStatus: 401,
      wrongTokenStatus: 401,
      forbiddenCallerStatus: 403,
      malformedBodyStatus: 400
    });

    const recoveredDrain = await dispatcher.drainOnce();
    assert.deepEqual(pick(recoveredDrain, ["claimed", "completed", "failed"]), {
      claimed: tenantFixtures.length,
      completed: tenantFixtures.length,
      failed: 0
    });
    const active = await currentAccessEvent(accessFixtureDb, tenantId);
    assert.equal(active.eventId, activeBeforeFailure.eventId);
    assert.equal(active.payloadSha256, activeBeforeFailure.payloadSha256);
    assert.equal(active.sourceVersion, activeBeforeFailure.sourceVersion);
    assert.equal(active.status, "published");
    await assertChannelSnapshot(channelDb, tenantId, "active", active.sourceVersion, active.eventId);
    for (const [index, tenant] of tenantFixtures.entries()) {
      const published = await currentAccessEvent(accessFixtureDb, tenant.tenantId);
      const before = initialEventsBeforeFailure[index];
      assert.equal(published.eventId, before.eventId);
      assert.equal(published.payloadSha256, before.payloadSha256);
      assert.equal(published.sourceVersion, before.sourceVersion);
      assert.equal(published.status, "published");
      await assertChannelSnapshot(
        channelDb,
        tenant.tenantId,
        tenant.status,
        published.sourceVersion,
        published.eventId
      );
    }

    // The legacy local tenant is still required by five Channel business FKs.
    // It is deliberately separate from the new projection and remains until the Channel contract cut.
    for (const [index, tenant] of tenantFixtures.entries()) {
      await pulsoFixtureDb.query(
        `insert into platform.tenants (id, slug, display_name, status, metadata)
         values ($1, $2, $3, $4, jsonb_build_object('acceptance', true, 'fixture', $5::text))`,
        [
          tenant.tenantId,
          `access-channel-${runId}-${index + 1}`,
          `Legacy Channel FK parity ${index + 1}`,
          tenant.status,
          tenant.fixture
        ]
      );
      await channelDb.query(
        "insert into channel_runtime.connections (tenant_id, metadata) values ($1, '{\"acceptance\":true}'::jsonb)",
        [tenant.tenantId]
      );
    }

    phase("advancing the provider-owned lifecycle active → paused → archived");
    const lifecycle = [active];
    for (const status of ["paused", "archived"]) {
      await accessFixtureDb.query("update platform.tenants set status = $2 where id = $1", [tenantId, status]);
      const reconciliation = await projections.reconcileAccessTenantSnapshots(identityDb, 10);
      assert.equal(reconciliation.eventsEnqueued, 1);
      const event = await currentAccessEvent(accessFixtureDb, tenantId);
      assert.equal(event.sourceVersion, lifecycle.at(-1).sourceVersion + 1);
      const drain = await dispatcher.drainOnce();
      assert.deepEqual(pick(drain, ["claimed", "completed", "failed"]), { claimed: 1, completed: 1, failed: 0 });
      const published = await currentAccessEvent(accessFixtureDb, tenantId);
      assert.equal(published.status, "published");
      await assertChannelSnapshot(channelDb, tenantId, status, published.sourceVersion, published.eventId);
      lifecycle.push(published);
    }

    await assert.rejects(
      accessFixtureDb.query("delete from platform.tenants where id = $1", [tenantId]),
      (error) => error?.code === "55000"
    );

    phase("replaying the exact archived event and measuring parity");
    const archivedBeforeReplay = lifecycle.at(-1);
    const channelBeforeReplay = await readChannelProjectionEvidence(channelDb, tenantId);
    assert.deepEqual(channelBeforeReplay, {
      inboxRows: 3,
      uniqueEventIds: 3,
      status: "archived",
      sourceVersion: String(archivedBeforeReplay.sourceVersion),
      sourceEventId: archivedBeforeReplay.eventId
    });
    await accessFixtureDb.query(
      "update access_runtime.tenant_projection_outbox set published_at = now() - interval '4 minutes' where id = $1",
      [archivedBeforeReplay.eventId]
    );
    const replay = await projections.replayCurrentAccessTenantProjection(identityDb, { tenantId });
    assert.deepEqual(replay, {
      eventId: archivedBeforeReplay.eventId,
      tenantId,
      sourceVersion: archivedBeforeReplay.sourceVersion,
      eventType: "access.tenant.snapshot.v1"
    });
    assert.equal(await projections.replayCurrentAccessTenantProjection(identityDb, { tenantId }), undefined);
    const queuedReplay = await currentAccessEvent(accessFixtureDb, tenantId);
    assert.equal(queuedReplay.eventId, archivedBeforeReplay.eventId);
    assert.equal(queuedReplay.payloadSha256, archivedBeforeReplay.payloadSha256);
    assert.equal(queuedReplay.sourceVersion, archivedBeforeReplay.sourceVersion);
    const replayDrain = await dispatcher.drainOnce();
    assert.deepEqual(pick(replayDrain, ["claimed", "completed", "failed"]), { claimed: 1, completed: 1, failed: 0 });
    const channelAfterReplay = await readChannelProjectionEvidence(channelDb, tenantId);
    assert.deepEqual(channelAfterReplay, channelBeforeReplay);
    await dispatcher.stop();

    const parity = await measureParity(accessFixtureDb, channelDb);
    assert.deepEqual(parity, {
      expectedTenants: tenantFixtures.length,
      destinationTenants: tenantFixtures.length,
      matchedTenants: tenantFixtures.length,
      coverageBasisPoints: 10_000,
      missingTenants: 0,
      extraTenants: 0,
      statusMismatches: 0,
      sourceVersionMismatches: 0,
      currentEventIdMismatches: 0,
      incompleteSourceRows: 0,
      incompleteDestinationRows: 0,
      bootstrapTenantsExcluded: 1,
      referencedTenantIds: tenantFixtures.length,
      referencedTenantIdsMissingSnapshot: 0,
      pendingOrDeadLetterEvents: 0,
      sourceVersionConflicts: 0
    });

    const isolation = await measureIsolation(
      createDatabase,
      adminUrl,
      names,
      postgresPort,
      secrets,
      identityDb,
      channelDb
    );
    assert.deepEqual(isolation, {
      logicalDatabases: 2,
      runtimeRolesSeparated: true,
      crossDatabaseConnectDenied: true,
      identityCanMutateTenant: false,
      channelProjectionDelete: false,
      projectionForeignKeysToPlatformTenants: 0,
      legacyChannelForeignKeysToPlatformTenants: 0,
      hardDeleteSqlState: "55000"
    });

    const ledgers = await readLedgers(accessFixtureDb, pulsoFixtureDb);
    assert.equal(ledgers.access.at(-1)?.name, "005-access-jwt-denylist.sql");
    // Channel projection lands at 004; the current contract tip persists the Access FK attestation at 016.
    assert.equal(ledgers.pulso.at(-1)?.name, "016-attest-access-fk-contract.sql");
    assert.ok(
      ledgers.pulso.some((entry) => entry.name === "004-access-channel-tenant-projection.sql"),
      "Access→Channel projection 004 must remain in the PULSO ledger"
    );
    assert.ok(
      ledgers.pulso.some((entry) => entry.name === "005-access-iris-tenant-projection.sql"),
      "Access→Iris projection 005 must remain in the PULSO ledger"
    );
    assert.ok(
      ledgers.pulso.some((entry) => entry.name === "006-access-sofia-tenant-projection.sql"),
      "Access→SOFIA projection 006 must remain in the PULSO ledger"
    );
    assert.ok(
      ledgers.pulso.some((entry) => entry.name === "007-access-integration-tenant-projection.sql"),
      "Access→Integration projection 007 must remain in the PULSO ledger"
    );

    acceptanceResult = {
      schemaVersion: 2,
      kind: "access-channel-tenant-projection-parity",
      operationId,
      provenance: {
        scope: "local-working-tree-rehearsal",
        publicationClaimed: false,
        registryReadbackPerformed: false,
        source,
        toolchain,
        buildArtifacts,
        postgresRuntime
      },
      transport: {
        protocol: "http",
        network: "loopback-tcp",
        producer: "identity-service",
        consumer: "whatsapp-channel-service",
        authenticated: true
      },
      contract: { eventType: "access.tenant.snapshot.v1", eventVersion: 1 },
      fixtures: {
        eligibleTenantCount: tenantFixtures.length,
        bootstrapTenantsExcluded: true,
        primaryTenantId: tenantId,
        tenantIds: tenantFixtures.map((tenant) => tenant.tenantId)
      },
      auth,
      outage: {
        failedAttempts: tenantFixtures.length,
        eventsAffected: tenantFixtures.length,
        recovered: true,
        eventIdentityPreserved: true,
        payloadPreserved: true,
        sourceVersionPreserved: true
      },
      lifecycle: lifecycle.map(({ envelope, status: _status, ...event }) => ({
        ...event,
        tenantStatus: envelope.payload.status
      })),
      replay: {
        result: "duplicate",
        eventId: archivedBeforeReplay.eventId,
        sourceVersion: archivedBeforeReplay.sourceVersion,
        payloadSha256: archivedBeforeReplay.payloadSha256,
        exactIdentityPreserved: true,
        inboxRowsBefore: channelBeforeReplay.inboxRows,
        inboxRowsAfter: channelAfterReplay.inboxRows,
        uniqueEvents: channelAfterReplay.uniqueEventIds,
        replayDidNotGrowInbox: channelAfterReplay.inboxRows === channelBeforeReplay.inboxRows,
        snapshotUnchanged: canonicalJson(channelAfterReplay) === canonicalJson(channelBeforeReplay)
      },
      parity,
      isolation,
      ledgers
    };
  } catch (error) {
    acceptanceError = error;
  } finally {
    for (const db of [identityDb, accessFixtureDb, pulsoFixtureDb, channelDb]) {
      if (!db) continue;
      try {
        await db.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (channelProcess) {
      try {
        await stopChild(channelProcess);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    activeChild = undefined;
    if (ownsContainer) {
      try {
        cleanupRemoval = await removeExactAcceptanceResources(names, runId);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  const inventoryAfter = await dockerInventory();
  const cleanup = {
    exactContainerRemoved: !(await containerExists(names.container)),
    labelNamespaceEmpty: (await labelledAcceptanceContainers(runId)).length === 0,
    removedOwnedContainers: cleanupRemoval.removedContainers,
    matchedByLabel: cleanupRemoval.matchedByLabel,
    preexistingContainerCount: inventoryBefore.length,
    finalContainerCount: inventoryAfter.length,
    preexistingInventorySha256: sha256(inventoryBefore.join("\n")),
    finalInventorySha256: sha256(inventoryAfter.join("\n")),
    preexistingResourcesPreserved: arraysEqual(inventoryBefore, inventoryAfter)
  };
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Access→Channel acceptance cleanup failed");
  if (acceptanceError) throw acceptanceError;
  if (receivedSignal) throw new Error(`Access→Channel acceptance interrupted by ${receivedSignal}`);
  assert.equal(cleanup.exactContainerRemoved, true);
  assert.equal(cleanup.labelNamespaceEmpty, true);
  assert.deepEqual(cleanup.removedOwnedContainers, [names.container]);
  assert.equal(cleanup.preexistingResourcesPreserved, true);

  const receipt = sealReceipt({ ...acceptanceResult, cleanup });
  if (options.receiptPath)
    await writeFile(options.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

async function measureParity(accessDb, channelDb) {
  const access = await accessDb.query(
    `select tenant.id as "tenantId", tenant.status,
            state.source_version::text as "sourceVersion",
            event.id as "currentEventId", event.status as "deliveryStatus"
       from platform.tenants tenant
       left join access_runtime.bootstrap_tenants bootstrap on bootstrap.tenant_id = tenant.id
       left join access_runtime.tenant_projection_state state on state.tenant_id = tenant.id
       left join access_runtime.tenant_projection_outbox event
         on event.tenant_id = state.tenant_id and event.source_version = state.source_version
      where bootstrap.tenant_id is null
      order by tenant.id`
  );
  const channel = await channelDb.query(
    `select snapshot.tenant_id as "tenantId", snapshot.status,
            snapshot.source_version::text as "sourceVersion",
            snapshot.source_event_id as "currentEventId",
            (current_event.id is not null) as "currentEventPresent"
       from channel_runtime.tenant_snapshots snapshot
       left join channel_runtime.access_projection_inbox current_event
         on current_event.id = snapshot.source_event_id and current_event.tenant_id = snapshot.tenant_id
      order by snapshot.tenant_id`
  );
  const expectedByTenant = new Map(access.rows.map((row) => [row.tenantId, row]));
  const destinationByTenant = new Map(channel.rows.map((row) => [row.tenantId, row]));
  const missingTenants = access.rows.filter((row) => !destinationByTenant.has(row.tenantId)).length;
  const extraTenants = channel.rows.filter((row) => !expectedByTenant.has(row.tenantId)).length;
  const paired = access.rows
    .map((expected) => ({ expected, actual: destinationByTenant.get(expected.tenantId) }))
    .filter((pair) => pair.actual !== undefined);
  const statusMismatches = paired.filter(({ expected, actual }) => expected.status !== actual.status).length;
  const sourceVersionMismatches = paired.filter(
    ({ expected, actual }) => expected.sourceVersion !== actual.sourceVersion
  ).length;
  const currentEventIdMismatches = paired.filter(
    ({ expected, actual }) => expected.currentEventId !== actual.currentEventId
  ).length;
  const incompleteSourceRows = access.rows.filter(
    (row) => row.sourceVersion === null || row.currentEventId === null || row.deliveryStatus !== "published"
  ).length;
  const incompleteDestinationRows = channel.rows.filter((row) => row.currentEventPresent !== true).length;
  const matchedTenants = paired.filter(
    ({ expected, actual }) =>
      expected.status === actual.status &&
      expected.sourceVersion === actual.sourceVersion &&
      expected.currentEventId === actual.currentEventId &&
      actual.currentEventPresent === true
  ).length;
  const bootstrap = await accessDb.query(
    `select count(*)::int as count
       from platform.tenants tenant
       join access_runtime.bootstrap_tenants bootstrap on bootstrap.tenant_id = tenant.id`
  );
  const references = await channelDb.query(
    `with referenced as (
       select tenant_id from channel_runtime.connections
       union select tenant_id from channel_runtime.delivery_receipts
       union select tenant_id from channel_runtime.inbound_events
       union select tenant_id from channel_runtime.outbound_messages
       union select tenant_id from channel_runtime.thread_bindings
     )
     select count(*)::int as "referencedTenantIds",
            count(*) filter (where snapshot.tenant_id is null)::int as "missing"
       from referenced
       left join channel_runtime.tenant_snapshots snapshot using (tenant_id)`
  );
  const pending = await accessDb.query(
    "select count(*)::int as count from access_runtime.tenant_projection_outbox where status <> 'published'"
  );
  const conflicts = await channelDb.query(
    `select count(*)::int as count
       from channel_runtime.access_projection_inbox
      where result->>'status' = 'conflict' and result->>'reason' = 'source_version'`
  );
  return {
    expectedTenants: access.rows.length,
    destinationTenants: channel.rows.length,
    matchedTenants,
    coverageBasisPoints: access.rows.length === 0 ? 0 : Math.floor((matchedTenants * 10_000) / access.rows.length),
    missingTenants,
    extraTenants,
    statusMismatches,
    sourceVersionMismatches,
    currentEventIdMismatches,
    incompleteSourceRows,
    incompleteDestinationRows,
    bootstrapTenantsExcluded: bootstrap.rows[0].count,
    referencedTenantIds: references.rows[0].referencedTenantIds,
    referencedTenantIdsMissingSnapshot: references.rows[0].missing,
    pendingOrDeadLetterEvents: pending.rows[0].count,
    sourceVersionConflicts: conflicts.rows[0].count
  };
}

async function measureIsolation(createDatabase, adminUrl, names, port, secrets, identityDb, channelDb) {
  const admin = createDatabase(adminUrl);
  try {
    const connect = await admin.query(
      `select has_database_privilege('hyperion_identity', $1, 'CONNECT') as "identityToPulso",
              has_database_privilege('hyperion_channel', $2, 'CONNECT') as "channelToAccess"`,
      [names.pulsoDatabase, names.accessDatabase]
    );
    assert.deepEqual(connect.rows, [{ identityToPulso: false, channelToAccess: false }]);
  } finally {
    await admin.close();
  }
  await assertDatabaseConnectionDenied(
    createDatabase,
    databaseUrl("hyperion_identity", secrets.identity, port, names.pulsoDatabase)
  );
  await assertDatabaseConnectionDenied(
    createDatabase,
    databaseUrl("hyperion_channel", secrets.channel, port, names.accessDatabase)
  );
  const identityAcl = await identityDb.query(
    `select has_table_privilege(current_user, 'platform.tenants', 'INSERT,UPDATE,DELETE') as "tenantMutation"`
  );
  const channelAcl = await channelDb.query(
    `select has_table_privilege(current_user, 'channel_runtime.tenant_snapshots', 'DELETE') as "projectionDelete"`
  );
  const foreignKeys = await channelDb.query(
    `select count(*) filter (
              where source_namespace.nspname = 'channel_runtime'
                and source_relation.relname in ('tenant_snapshots', 'access_projection_inbox')
                and target_namespace.nspname = 'platform' and target_relation.relname = 'tenants'
            )::int as "projectionForeignKeys",
            count(*) filter (
              where source_namespace.nspname = 'channel_runtime'
                and source_relation.relname in (
                  'connections', 'delivery_receipts', 'inbound_events', 'outbound_messages', 'thread_bindings'
                )
                and target_namespace.nspname = 'platform' and target_relation.relname = 'tenants'
            )::int as "legacyForeignKeys"
       from pg_constraint constraint_state
       join pg_class source_relation on source_relation.oid = constraint_state.conrelid
       join pg_namespace source_namespace on source_namespace.oid = source_relation.relnamespace
       join pg_class target_relation on target_relation.oid = constraint_state.confrelid
       join pg_namespace target_namespace on target_namespace.oid = target_relation.relnamespace
      where constraint_state.contype = 'f'`
  );
  return {
    logicalDatabases: new Set([names.accessDatabase, names.pulsoDatabase]).size,
    runtimeRolesSeparated: true,
    crossDatabaseConnectDenied: true,
    identityCanMutateTenant: identityAcl.rows[0].tenantMutation,
    channelProjectionDelete: channelAcl.rows[0].projectionDelete,
    projectionForeignKeysToPlatformTenants: foreignKeys.rows[0].projectionForeignKeys,
    legacyChannelForeignKeysToPlatformTenants: foreignKeys.rows[0].legacyForeignKeys,
    hardDeleteSqlState: "55000"
  };
}

async function assertDatabaseConnectionDenied(createDatabase, connectionString) {
  const db = createDatabase(connectionString);
  try {
    await assert.rejects(db.query("select 1"), (error) => error?.code === "42501");
  } finally {
    await db.close();
  }
}

async function currentAccessEvent(db, tenantId) {
  const result = await db.query(
    `select event.id as "eventId", event.source_version::text as "sourceVersion", event.status,
            event.payload, event.event_type as "eventType", event.event_version as "eventVersion",
            event.occurred_at as "occurredAt"
       from access_runtime.tenant_projection_outbox event
       join access_runtime.tenant_projection_state state
         on state.tenant_id = event.tenant_id and state.source_version = event.source_version
      where event.tenant_id = $1`,
    [tenantId]
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  const envelope = {
    id: row.eventId,
    type: row.eventType,
    version: row.eventVersion,
    occurredAt: new Date(row.occurredAt).toISOString(),
    tenantId,
    payload: row.payload
  };
  return {
    eventId: row.eventId,
    sourceVersion: Number(row.sourceVersion),
    payloadSha256: sha256(canonicalJson(row.payload)),
    status: row.status,
    envelope
  };
}

async function assertChannelSnapshot(db, tenantId, status, sourceVersion, eventId) {
  const result = await db.query(
    `select status, source_version::text as "sourceVersion", source_event_id as "eventId"
       from channel_runtime.tenant_snapshots where tenant_id = $1`,
    [tenantId]
  );
  assert.deepEqual(result.rows, [{ status, sourceVersion: String(sourceVersion), eventId }]);
}

async function readChannelProjectionEvidence(db, tenantId) {
  const result = await db.query(
    `select snapshot.status, snapshot.source_version::text as "sourceVersion",
            snapshot.source_event_id as "sourceEventId",
            count(inbox.id)::int as "inboxRows",
            count(distinct inbox.id)::int as "uniqueEventIds"
       from channel_runtime.tenant_snapshots snapshot
       left join channel_runtime.access_projection_inbox inbox on inbox.tenant_id = snapshot.tenant_id
      where snapshot.tenant_id = $1
      group by snapshot.tenant_id, snapshot.status, snapshot.source_version, snapshot.source_event_id`,
    [tenantId]
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function readLedgers(accessDb, pulsoDb) {
  const [access, pulso] = await Promise.all([
    accessDb.query("select name, checksum from access_runtime.migration_ledger order by name"),
    pulsoDb.query("select name, checksum from pulso_iris.migration_ledger order by name")
  ]);
  return { access: access.rows, pulso: pulso.rows };
}

function startChannelProcess(port, databaseUrlValue, edgeToken) {
  const child = spawn(
    process.execPath,
    [path.join(repositoryRoot, "services/whatsapp-channel-service/dist/index.js")],
    {
      cwd: repositoryRoot,
      env: sanitizedEnvironment({
        NODE_ENV: "test",
        HYPERION_ENVIRONMENT: "local",
        HOST: "127.0.0.1",
        PORT: String(port),
        DATABASE_URL: databaseUrlValue,
        EXPECTED_DATABASE_ROLE: "hyperion_channel",
        ACCESS_TO_CHANNEL_TOKEN: edgeToken,
        DURABLE_EVENT_TRANSPORT: "http",
        DURABLE_OUTBOX_ENABLED: "false",
        DURABLE_HTTP_OUTBOX_ENABLED: "false",
        WHATSAPP_WEB_TEST_ENABLED: "false"
      }),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

async function waitForHttp(url, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`WhatsApp Channel exited before readiness (${child.exitCode})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch {
      // Retry while the real process binds and completes readiness.
    }
    await delay(250);
  }
  throw new Error("WhatsApp Channel did not become ready within 30 seconds");
}

async function postStatus(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(5_000)
  });
  await response.arrayBuffer();
  return response.status;
}

function workloadHeaders(token) {
  return { authorization: `Bearer ${token}`, "x-hyperion-caller": "identity-service" };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gracefulExit = waitForChildExit(child, 10_000);
  child.kill("SIGTERM");
  if (await gracefulExit) return;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (!(await waitForChildExit(child, 5_000))) {
    throw new Error(`Child process ${child.pid ?? "unknown"} did not exit after SIGKILL`);
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(value);
    };
    const onExit = () => finish(true);
    const onError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      reject(error);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("error", onError);
    // Close the small gap between the initial state check and listener setup.
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function acceptanceSecrets() {
  const secret = (label) => `${label}-${randomBytes(24).toString("base64url")}`;
  return Object.freeze({
    adminUser: "hyperion",
    adminPassword: secret("admin"),
    accessMigrator: secret("access-migrator"),
    identity: secret("identity"),
    tenant: secret("tenant"),
    pulsoMigrator: secret("pulso-migrator"),
    pulso: secret("pulso"),
    sofia: secret("sofia"),
    knowledge: secret("knowledge"),
    integration: secret("integration"),
    channel: secret("channel"),
    edgeToken: secret("access-channel-edge")
  });
}

function databaseUrl(user, password, port, database) {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

async function runPackage(packageName, script, extraEnvironment) {
  await run(pnpm, ["--filter", packageName, script], { env: sanitizedEnvironment(extraEnvironment) });
}

function sanitizedEnvironment(extra = {}) {
  return {
    ...Object.fromEntries(
      allowedParentEnvironment
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]])
    ),
    CI: "true",
    HYPERION_ENVIRONMENT: "local",
    ...extra
  };
}

async function sourceEvidence() {
  const revision = (await run("git", ["rev-parse", "HEAD"], { capture: true })).stdout.trim();
  const branch = (await run("git", ["branch", "--show-current"], { capture: true })).stdout.trim() || "detached";
  const statusOutput = (
    await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { capture: true })
  ).stdout;
  const patchOutput = (await run("git", ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], { capture: true })).stdout;
  const harnessPath = path.join(repositoryRoot, "scripts", "autonomy", "access-channel-projection.e2e.mjs");
  return {
    branch,
    revision,
    workingTreeIncluded: true,
    workingTreeDirty: statusOutput.length > 0,
    workingTreeStatusSha256: sha256(statusOutput),
    workingTreePatchSha256: sha256(patchOutput),
    harnessSha256: sha256(await readFile(harnessPath)),
    closure: await hashRepositoryClosure(sourceClosurePaths, { excludeGenerated: true }),
    packageVersions: await packageVersionEvidence()
  };
}

async function packageVersionEvidence() {
  const directories = [
    "packages/access-migrations",
    "packages/config",
    "packages/database",
    "packages/durable-events",
    "packages/logger",
    "packages/platform-contracts",
    "packages/pulso-contracts",
    "packages/pulso-migrations",
    "packages/service-runtime",
    "services/identity-service",
    "services/whatsapp-channel-service"
  ];
  const packages = [];
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, directory, "package.json"), "utf8"));
    assert.equal(typeof manifest.name, "string");
    assert.equal(typeof manifest.version, "string");
    packages.push({ name: manifest.name, version: manifest.version });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

async function toolchainEvidence() {
  return {
    node: await binaryEvidence(process.execPath, process.version),
    pnpm: await commandBinaryEvidence(pnpm, ["--version"]),
    docker: await commandBinaryEvidence(docker, ["--version"]),
    git: await commandBinaryEvidence(process.platform === "win32" ? "git.exe" : "git", ["--version"]),
    platform: process.platform,
    architecture: process.arch
  };
}

async function commandBinaryEvidence(command, versionArguments) {
  const executable = await resolveExecutable(command);
  const versionResult = await run(command, versionArguments, { capture: true });
  const version = `${versionResult.stdout}\n${versionResult.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!version) throw new Error(`Unable to read ${command} version`);
  return binaryEvidence(executable, version);
}

async function binaryEvidence(executable, version) {
  const resolved = await realpath(executable);
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new Error(`Toolchain executable is not a regular file: ${path.basename(resolved)}`);
  return {
    executable: path.basename(resolved),
    version,
    binarySha256: sha256(await readFile(resolved))
  };
}

async function resolveExecutable(command) {
  if (path.isAbsolute(command)) return command;
  const resolver = process.platform === "win32" ? "where.exe" : "which";
  const result = await run(resolver, [command], { capture: true });
  const resolved = result.stdout
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
  if (!resolved) throw new Error(`Unable to resolve executable ${command}`);
  return resolved;
}

async function hashRepositoryClosure(relativePaths, options = {}) {
  const rows = new Map();
  const visit = async (absolute) => {
    const metadata = await stat(absolute);
    if (metadata.isFile()) {
      const relative = repositoryRelativePath(absolute);
      rows.set(relative, `${relative}\t${sha256(await readFile(absolute))}`);
      return;
    }
    if (!metadata.isDirectory()) throw new Error(`Unsupported closure entry: ${absolute}`);
    for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (entry.isSymbolicLink())
        throw new Error(`Source closure contains a symbolic link: ${path.join(absolute, entry.name)}`);
      if (entry.isDirectory() && options.excludeGenerated && closureExcludedDirectories.has(entry.name)) continue;
      await visit(path.join(absolute, entry.name));
    }
  };
  for (const relativePath of relativePaths) {
    const absolute = path.resolve(repositoryRoot, ...relativePath.split("/"));
    repositoryRelativePath(absolute);
    await visit(absolute);
  }
  const manifest = [...rows.values()].sort();
  return { files: manifest.length, sha256: sha256(`${manifest.join("\n")}\n`) };
}

function repositoryRelativePath(absolute) {
  const relative = path.relative(repositoryRoot, absolute).replaceAll("\\", "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Closure path escapes the repository: ${absolute}`);
  }
  return relative;
}

async function postgresImageEvidence(container) {
  const imageId = (
    await run(docker, ["container", "inspect", "--format", "{{.Image}}", container], { capture: true })
  ).stdout.trim();
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const repoDigestsOutput = (
    await run(docker, ["image", "inspect", "--format", "{{json .RepoDigests}}", imageId], { capture: true })
  ).stdout.trim();
  const repoDigests = JSON.parse(repoDigestsOutput);
  const pinnedDigest = postgresImage.slice(postgresImage.lastIndexOf("@") + 1);
  assert.match(pinnedDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(repoDigests.some((digest) => digest.endsWith(`@${pinnedDigest}`)));
  const postgresVersion = (
    await run(docker, ["exec", container, "postgres", "--version"], { capture: true })
  ).stdout.trim();
  assert.match(postgresVersion, /^postgres \(PostgreSQL\) 16\./);
  return {
    requestedReference: postgresImage,
    pinnedDigest,
    localImageId: imageId,
    repoDigestVerified: true,
    postgresVersion
  };
}

async function waitForHealthy(container) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await run(docker, ["inspect", "--format", "{{.State.Health.Status}}", container], {
      allowFailure: true,
      capture: true
    });
    if (result.code === 0 && result.stdout.trim() === "healthy") return;
    await delay(500);
  }
  throw new Error("Disposable PostgreSQL did not become healthy within 30 seconds");
}

async function publishedLoopbackPort(container) {
  const result = await run(docker, ["port", container, "5432/tcp"], { capture: true });
  const match = result.stdout.trim().match(/^(?:127\.0\.0\.1|\[::1\]):(\d+)$/);
  if (!match) throw new Error("PostgreSQL acceptance port is not bound exclusively to loopback");
  return Number(match[1]);
}

async function dockerInventory() {
  const result = await run(docker, ["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"], {
    capture: true
  });
  return result.stdout.split(/\r?\n/).filter(Boolean).sort();
}

async function assertContainerAbsent(container) {
  if (await containerExists(container)) throw new Error(`Refusing to reuse existing container ${container}`);
}

async function assertLabelNamespaceAbsent(runId) {
  const matches = await labelledAcceptanceContainers(runId);
  if (matches.length > 0) {
    throw new Error(`Refusing to reuse Access→Channel acceptance labels: ${matches.join(", ")}`);
  }
}

async function containerExists(container) {
  const result = await run(docker, ["container", "inspect", container], { allowFailure: true, capture: true });
  return result.code === 0;
}

async function labelledAcceptanceContainers(runId) {
  if (!runIdPattern.test(runId)) throw new Error("Refusing unsafe acceptance label selector");
  const result = await run(
    docker,
    [
      "container",
      "ls",
      "--all",
      "--filter",
      `label=${acceptanceLabel}`,
      "--filter",
      `label=${runLabelKey}=${runId}`,
      "--format",
      "{{.Names}}"
    ],
    { capture: true }
  );
  const matches = result.stdout.split(/\r?\n/).filter(Boolean).sort();
  for (const container of matches) {
    if (!containerPattern.test(container) || container !== `hyperion-access-channel-acceptance-${runId}`) {
      throw new Error(`Refusing unsafe labelled acceptance cleanup target ${container}`);
    }
  }
  return matches;
}

async function exactContainerHasAcceptanceLabels(container, runId) {
  const result = await run(
    docker,
    [
      "container",
      "inspect",
      "--format",
      `{{index .Config.Labels "com.hyperion.acceptance"}}|{{index .Config.Labels "${runLabelKey}"}}`,
      container
    ],
    { allowFailure: true, capture: true }
  );
  if (result.code !== 0) return false;
  return result.stdout.trim() === `access-channel-projection|${runId}`;
}

async function removeExactAcceptanceResources(names, runId) {
  if (!containerPattern.test(names.container) || names.container !== `hyperion-access-channel-acceptance-${runId}`) {
    throw new Error("Refusing unsafe acceptance cleanup namespace");
  }
  const matchedByLabel = new Set();
  const removedContainers = new Set();
  let consecutiveEmptyObservations = 0;
  for (let attempt = 0; attempt < 8 && consecutiveEmptyObservations < 2; attempt += 1) {
    const labelled = await labelledAcceptanceContainers(runId);
    for (const container of labelled) matchedByLabel.add(container);
    const exactExists = await containerExists(names.container);
    if (exactExists && !(await exactContainerHasAcceptanceLabels(names.container, runId))) {
      throw new Error(`Refusing to remove unlabelled or foreign container ${names.container}`);
    }
    const targets = new Set(labelled);
    if (exactExists) targets.add(names.container);
    if (targets.size === 0) {
      consecutiveEmptyObservations += 1;
    } else {
      consecutiveEmptyObservations = 0;
      for (const container of targets) {
        await run(docker, ["container", "rm", "--force", "--volumes", container]);
        removedContainers.add(container);
      }
    }
    if (consecutiveEmptyObservations < 2) await delay(250);
  }
  if ((await containerExists(names.container)) || (await labelledAcceptanceContainers(runId)).length > 0) {
    throw new Error(`Acceptance cleanup namespace did not become empty: ${names.container}`);
  }
  return { removedContainers: [...removedContainers].sort(), matchedByLabel: [...matchedByLabel].sort() };
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? sanitizedEnvironment(),
    shell: false,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  activeChild = child;
  let stdout = "";
  let stderr = "";
  if (options.capture) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
  }
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  activeChild = undefined;
  if (!options.allowFailure && (result.signal || result.code !== 0)) {
    throw new Error(`${command} failed (${result.signal ?? result.code})${stderr ? `: ${stderr.trim()}` : ""}`);
  }
  return result;
}

function phase(message) {
  process.stderr.write(`[access-channel-acceptance] ${message}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--receipt") options.receiptPath = argv[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}`);
  }
  return options;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      receivedSignal = signal;
      activeChild?.kill(signal);
    });
  }
  runAccessChannelAcceptance(process.env, parseArguments(process.argv.slice(2)))
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}

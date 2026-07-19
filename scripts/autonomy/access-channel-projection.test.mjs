import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acceptanceNames, canonicalJson, sealReceipt } from "./access-channel-projection.e2e.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = path.join(repositoryRoot, "scripts/autonomy/access-channel-projection.e2e.mjs");
const workflowPath = path.join(repositoryRoot, ".github/workflows/access-channel-projection.yml");
const evidencePath = path.join(repositoryRoot, "docs/evidence/access-channel-projection-parity-20260719.json");

test("acceptance resources are confined to one unambiguous run namespace", () => {
  assert.deepEqual(acceptanceNames("a1b2c3d4e5f6"), {
    container: "hyperion-access-channel-acceptance-a1b2c3d4e5f6",
    accessDatabase: "access_acceptance_a1b2c3d4e5f6",
    pulsoDatabase: "pulso_acceptance_a1b2c3d4e5f6"
  });
  for (const unsafe of ["", "A1B2C3D4E5F6", "abc", "../../escape", "a1b2c3d4e5f6-extra"]) {
    assert.throws(() => acceptanceNames(unsafe));
  }
});

test("the receipt uses canonical key order and seals all evidence fields", () => {
  assert.equal(
    canonicalJson({ z: 2, nested: { b: true, a: [3, "x"] }, a: 1 }),
    '{"a":1,"nested":{"a":[3,"x"],"b":true},"z":2}'
  );
  const left = sealReceipt({ z: 2, a: 1 });
  const right = sealReceipt({ a: 1, z: 2 });
  assert.match(left.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(left.receiptSha256, right.receiptSha256);
  assert.notEqual(sealReceipt({ a: 1, z: 3 }).receiptSha256, left.receiptSha256);
});

test("the checked-in real rehearsal receipt has a valid canonical seal", async () => {
  const receipt = JSON.parse(await readFile(evidencePath, "utf8"));
  const { receiptSha256, ...evidence } = receipt;
  assert.equal(sealReceipt(evidence).receiptSha256, receiptSha256);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.fixtures.eligibleTenantCount, 3);
  assert.equal(receipt.fixtures.bootstrapTenantsExcluded, true);
  assert.equal(receipt.fixtures.tenantIds.length, 3);
  assert.equal(new Set(receipt.fixtures.tenantIds).size, 3);
  assert.equal(receipt.auth.wrongTokenStatus, 401);
  assert.deepEqual(
    receipt.lifecycle.map((event) => event.tenantStatus),
    ["active", "paused", "archived"]
  );
  assert.deepEqual(receipt.outage, {
    failedAttempts: 3,
    eventsAffected: 3,
    recovered: true,
    eventIdentityPreserved: true,
    payloadPreserved: true,
    sourceVersionPreserved: true
  });
  assert.equal(receipt.replay.uniqueEvents, 3);
  assert.equal(receipt.replay.inboxRowsBefore, receipt.replay.inboxRowsAfter);
  assert.equal(receipt.replay.replayDidNotGrowInbox, true);
  assert.equal(receipt.replay.snapshotUnchanged, true);
  assert.deepEqual(receipt.parity, {
    expectedTenants: 3,
    destinationTenants: 3,
    matchedTenants: 3,
    coverageBasisPoints: 10_000,
    missingTenants: 0,
    extraTenants: 0,
    statusMismatches: 0,
    sourceVersionMismatches: 0,
    currentEventIdMismatches: 0,
    incompleteSourceRows: 0,
    incompleteDestinationRows: 0,
    bootstrapTenantsExcluded: 1,
    referencedTenantIds: 3,
    referencedTenantIdsMissingSnapshot: 0,
    pendingOrDeadLetterEvents: 0,
    sourceVersionConflicts: 0
  });
  assert.equal(receipt.provenance.scope, "local-working-tree-rehearsal");
  assert.equal(receipt.provenance.publicationClaimed, false);
  assert.equal(receipt.provenance.registryReadbackPerformed, false);
  assert.match(receipt.provenance.source.revision, /^[a-f0-9]{40}$/);
  assert.equal(typeof receipt.provenance.source.workingTreeDirty, "boolean");
  assert.equal(
    createHash("sha256")
      .update(await readFile(scriptPath))
      .digest("hex"),
    receipt.provenance.source.harnessSha256
  );
  for (const digest of [
    receipt.provenance.source.workingTreeStatusSha256,
    receipt.provenance.source.workingTreePatchSha256,
    receipt.provenance.source.harnessSha256,
    receipt.provenance.source.closure.sha256,
    receipt.provenance.buildArtifacts.sha256,
    receipt.provenance.toolchain.node.binarySha256,
    receipt.provenance.toolchain.pnpm.binarySha256,
    receipt.provenance.toolchain.docker.binarySha256,
    receipt.provenance.toolchain.git.binarySha256
  ])
    assert.match(digest, /^[a-f0-9]{64}$/);
  assert.ok(receipt.provenance.source.closure.files > 0);
  assert.ok(receipt.provenance.buildArtifacts.files > 0);
  assert.ok(receipt.provenance.source.packageVersions.length >= 9);
  assert.match(receipt.provenance.postgresRuntime.requestedReference, /@sha256:[a-f0-9]{64}$/);
  assert.equal(
    receipt.provenance.postgresRuntime.requestedReference.endsWith(
      `@${receipt.provenance.postgresRuntime.pinnedDigest}`
    ),
    true
  );
  assert.match(receipt.provenance.postgresRuntime.localImageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.provenance.postgresRuntime.repoDigestVerified, true);
  assert.equal(receipt.isolation.runtimeRolesSeparated, true);
  assert.equal(receipt.isolation.crossDatabaseConnectDenied, true);
  assert.equal(receipt.isolation.identityCanMutateTenant, false);
  assert.equal(receipt.isolation.channelProjectionDelete, false);
  assert.equal(receipt.isolation.projectionForeignKeysToPlatformTenants, 0);
  assert.equal(receipt.isolation.legacyChannelForeignKeysToPlatformTenants, 5);
  assert.equal(receipt.cleanup.exactContainerRemoved, true);
  assert.equal(receipt.cleanup.labelNamespaceEmpty, true);
  assert.equal(receipt.cleanup.removedOwnedContainers.length, 1);
  assert.deepEqual(receipt.cleanup.matchedByLabel, receipt.cleanup.removedOwnedContainers);
  assert.equal(receipt.cleanup.preexistingResourcesPreserved, true);
  assert.equal(receipt.cleanup.preexistingContainerCount, 17);
  assert.equal(receipt.cleanup.finalContainerCount, 17);
  assert.equal(receipt.cleanup.preexistingInventorySha256, receipt.cleanup.finalInventorySha256);
  assert.equal(receipt.ledgers.access.at(-1).name, "004-access-tenant-lifecycle-integrity.sql");
  assert.equal(receipt.ledgers.pulso.at(-1).name, "004-access-channel-tenant-projection.sql");
});

test("the real boundary rehearsal is opt-in, isolated and preserves exact evidence", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.match(source, /RUN_ACCESS_CHANNEL_ACCEPTANCE/);
  assert.match(source, /postgres:16-alpine@sha256:[a-f0-9]{64}/);
  assert.match(source, /accessDatabase: `access_acceptance_/);
  assert.match(source, /pulsoDatabase: `pulso_acceptance_/);
  assert.match(source, /hyperion_identity/);
  assert.match(source, /hyperion_channel/);
  assert.match(source, /127\.0\.0\.1::5432/);
  assert.match(source, /com\.hyperion\.acceptance=access-channel-projection/);
  assert.match(source, /com\.hyperion\.acceptance\.run-id/);
  assert.match(source, /access-tenant-snapshots/);
  assert.match(source, /unauthenticatedStatus: 401/);
  assert.match(source, /wrongTokenStatus: 401/);
  assert.match(source, /forbiddenCallerStatus: 403/);
  assert.match(source, /malformedBodyStatus: 400/);
  assert.match(source, /active.*paused.*archived/s);
  assert.match(source, /replayCurrentAccessTenantProjection/);
  assert.match(source, /payloadSha256/);
  assert.match(source, /replayDidNotGrowInbox/);
  assert.match(source, /uniqueEvents/);
  assert.match(source, /pendingOrDeadLetterEvents: 0/);
  assert.match(source, /coverageBasisPoints: 10_000/);
  assert.match(source, /left join access_runtime\.bootstrap_tenants bootstrap/);
  assert.match(source, /left join channel_runtime\.access_projection_inbox current_event/);
  assert.match(source, /missingTenants: 0/);
  assert.match(source, /extraTenants: 0/);
  assert.match(source, /statusMismatches: 0/);
  assert.match(source, /sourceVersionMismatches: 0/);
  assert.match(source, /currentEventIdMismatches: 0/);
  assert.match(source, /sourceVersionConflicts: 0/);
  assert.doesNotMatch(source, /inboxConflicts/);
  assert.match(source, /referencedTenantIdsMissingSnapshot: 0/);
  assert.match(source, /projectionForeignKeysToPlatformTenants: 0/);
  assert.match(source, /legacyChannelForeignKeysToPlatformTenants: 5/);
  assert.match(source, /hardDeleteSqlState: "55000"/);
  assert.match(source, /004-access-tenant-lifecycle-integrity\.sql/);
  assert.match(source, /004-access-channel-tenant-projection\.sql/);
  assert.match(source, /container", "rm", "--force", "--volumes"/);
  assert.match(source, /removeExactAcceptanceResources/);
  assert.match(source, /waitForChildExit/);
  assert.match(source, /SIGKILL/);
  assert.match(source, /workingTreeStatusSha256/);
  assert.match(source, /workingTreePatchSha256/);
  assert.match(source, /harnessSha256/);
  assert.match(source, /buildArtifacts/);
  assert.match(source, /binarySha256/);
  assert.match(source, /repoDigestVerified/);
  assert.match(source, /publicationClaimed: false/);
  assert.match(source, /preexistingResourcesPreserved/);
  assert.doesNotMatch(source, /005-/);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^\n]*(?:password|token|secret)/i);

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repositoryRoot,
    env: Object.fromEntries(
      ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec", "HOME", "USERPROFILE"]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]])
    ),
    encoding: "utf8",
    shell: false,
    timeout: 5_000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set RUN_ACCESS_CHANNEL_ACCEPTANCE=1/);
  assert.equal(result.stdout, "");
});

test("the dedicated boundary workflow runs only for affected Platform or PULSO closures", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /cancel-in-progress:\s*true/);
  assert.match(workflow, /resolve-access-channel-impact\.mjs/);
  assert.match(workflow, /affected: \$\{\{ steps\.impact\.outputs\.affected \}\}/);
  assert.match(workflow, /cell-install-plan\.mjs --cell platform/);
  assert.match(workflow, /cell-install-plan\.mjs --cell pulso/);
  assert.match(workflow, /RUN_ACCESS_CHANNEL_ACCEPTANCE: "1"/);
  assert.match(workflow, /access-channel-projection-receipt\.json/);
  assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(workflow, /name: access-channel \/ required/);
  assert.doesNotMatch(workflow, /pnpm (?:-r|--recursive) build/);
  assert.doesNotMatch(workflow, /pnpm install --frozen-lockfile/);
});

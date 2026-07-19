import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const verifier = resolve(scriptDirectory, "verify-nova-recovery-evidence.mjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sha256Content(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sha256File(path) {
  return sha256Content(readFileSync(path));
}

function portable(root, path) {
  return relative(root, path).split(sep).join("/");
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "hyperion-recovery-test."));
  temporaryDirectories.push(root);
  const operationId = "20260717T220000Z";
  const backupRoot = join(root, "backups", "nova");
  const databaseArchive = join(backupRoot, `nova-${operationId}.dump.gz`);
  const snapshotDirectory = join(backupRoot, "documents", `nova-documents-${operationId}`);
  const drillDirectory = join(backupRoot, "drills", operationId);
  mkdirSync(snapshotDirectory, { recursive: true });
  mkdirSync(drillDirectory, { recursive: true });
  writeFileSync(databaseArchive, gzipSync("NOVA_DATABASE_DRILL"));

  const bucket = "nova-documents-drill";
  const snapshotReference = "minio://nova-drill/snapshot-0001\n";
  const inventory = `${"a".repeat(64)}\t3\ta.txt\n${"b".repeat(64)}\t5\tfolder%2Fb.txt\n`;
  const snapshotRefPath = join(snapshotDirectory, "snapshot.ref");
  const inventoryPath = join(snapshotDirectory, "inventory.tsv");
  writeFileSync(snapshotRefPath, snapshotReference);
  writeFileSync(inventoryPath, inventory);
  writeFileSync(join(snapshotDirectory, "bucket"), `${bucket}\n`);
  const snapshotSha256 = sha256File(snapshotRefPath);
  const inventorySha256 = sha256File(inventoryPath);
  const bundleSha256 = sha256Content(`${bucket}\n${snapshotSha256}\n${inventorySha256}\n2\n8\n`);
  writeFileSync(join(snapshotDirectory, "bundle.sha256"), `${bundleSha256}\n`);

  const backupNames = [
    "documents-writes-frozen",
    "postgres-exported",
    "documents-exported",
    "documents-writes-unfrozen"
  ];
  const restoreNames = [
    "documents-writes-frozen",
    "documents-restored-and-inventory-verified",
    "postgres-restored",
    "nova-smoke-passed",
    "documents-writes-unfrozen"
  ];
  const makeSteps = (phase, names, startMinute) =>
    names.map((name, index) => {
      const receiptPath = join(drillDirectory, `${phase}-${String(index + 1).padStart(2, "0")}-${name}.receipt`);
      writeFileSync(receiptPath, `${name}=verified\n`);
      return {
        name,
        completedAt: `2026-07-17T22:${String(startMinute + index).padStart(2, "0")}:00.000Z`,
        receipt: portable(root, receiptPath),
        sha256: sha256File(receiptPath)
      };
    });
  const evidence = {
    schemaVersion: 1,
    cell: "nova",
    operationId,
    consistencyMode: "documents-write-quiesce",
    database: {
      sourceDatabase: "hyperion_nova",
      restoreDatabase: "hyperion_nova_restore_drill",
      owner: "hyperion_nova_migrator",
      archive: portable(root, databaseArchive),
      sha256: sha256File(databaseArchive)
    },
    documents: {
      bucket,
      snapshotDirectory: portable(root, snapshotDirectory),
      snapshotSha256,
      inventorySha256,
      bundleSha256,
      objectCount: 2,
      totalBytes: 8
    },
    backupSteps: makeSteps("backup", backupNames, 0),
    restoreSteps: makeSteps("restore", restoreNames, 10)
  };
  const evidencePath = join(drillDirectory, "evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { root, evidence, evidencePath, inventoryPath };
}

function verify(fixture) {
  return spawnSync(process.execPath, [verifier, "--evidence", portable(fixture.root, fixture.evidencePath)], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      NOVA_OPS_TEST_MODE: "1",
      NOVA_OPS_TEST_ROOT: fixture.root
    }
  });
}

test("verifies coordinated NOVA database and Documents recovery evidence in exact order", () => {
  const fixture = createFixture();
  const result = verify(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NOVA_RECOVERY_ORDER_VERIFIED=true/);
  assert.match(result.stdout, /NOVA_RECOVERY_OBJECT_COUNT=2/);
  assert.match(result.stdout, /NOVA_RECOVERY_BACKUP_DURATION_SECONDS=180/);
  assert.match(result.stdout, /NOVA_RECOVERY_RESTORE_DURATION_SECONDS=240/);
});

test("rejects a Documents object inventory changed after the coordinated backup", () => {
  const fixture = createFixture();
  writeFileSync(fixture.inventoryPath, `${readFileSync(fixture.inventoryPath, "utf8")}extra\t0\tz.txt\n`);
  const result = verify(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inventory SHA-256 differs/);
});

test("rejects recovery steps out of the safe Documents-before-database restore order", () => {
  const fixture = createFixture();
  [fixture.evidence.restoreSteps[1], fixture.evidence.restoreSteps[2]] = [
    fixture.evidence.restoreSteps[2],
    fixture.evidence.restoreSteps[1]
  ];
  writeFileSync(fixture.evidencePath, `${JSON.stringify(fixture.evidence, null, 2)}\n`);
  const result = verify(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restoreSteps\[1\] must be documents-restored-and-inventory-verified/);
});

test("rejects a receipt digest that cannot prove the recorded operation", () => {
  const fixture = createFixture();
  fixture.evidence.backupSteps[0].sha256 = "f".repeat(64);
  writeFileSync(fixture.evidencePath, `${JSON.stringify(fixture.evidence, null, 2)}\n`);
  const result = verify(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /receipt SHA-256 differs from evidence/);
});

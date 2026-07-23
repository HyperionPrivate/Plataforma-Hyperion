import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const allTestScripts = [
  "scripts/ops/postgres-backup.test.sh",
  "scripts/ops/postgres-restore.test.sh",
  "scripts/ops/platform-postgres-hooks.test.sh",
  "scripts/ops/nova-postgres-hooks.test.sh",
  "scripts/ops/nova-documents-snapshot.test.sh",
  "scripts/ops/lumen-postgres-hooks.test.sh",
  "scripts/ops/pulso-postgres-hooks.test.sh",
  "scripts/ops/pulso-whatsapp-sessions-snapshot.test.sh"
];
const allNodeTests = [
  "scripts/ops/run-nova-postgres-recovery-drill.test.mjs",
  "scripts/ops/run-platform-postgres-recovery-drill.test.mjs",
  "scripts/ops/verify-nova-rollback.test.mjs",
  "scripts/ops/verify-nova-recovery-evidence.test.mjs",
  "scripts/ops/run-lumen-postgres-recovery-drill.test.mjs",
  "scripts/ops/verify-lumen-rollback.test.mjs",
  "scripts/ops/run-pulso-postgres-recovery-drill.test.mjs",
  "scripts/ops/verify-pulso-postgres-recovery-evidence.test.mjs",
  "scripts/ops/verify-pulso-rollback.test.mjs",
  "scripts/ops/run-pulso-whatsapp-recovery-drill.test.mjs"
];
const args = process.argv.slice(2);
let selectedCell = null;
if (args.length > 0) {
  if (
    args.length !== 2 ||
    args[0] !== "--cell" ||
    !["platform", "access", "audit", "nova", "lumen", "pulso"].includes(args[1])
  ) {
    process.stderr.write(
      "Usage: node scripts/ops/run-postgres-backup-tests.mjs [--cell platform|access|audit|nova|lumen|pulso]\n"
    );
    process.exit(1);
  }
  selectedCell = args[1];
}
const testScripts =
  selectedCell === "platform" || selectedCell === "access" || selectedCell === "audit"
    ? ["scripts/ops/platform-postgres-hooks.test.sh"]
    : selectedCell === "pulso"
      ? ["scripts/ops/pulso-postgres-hooks.test.sh", "scripts/ops/pulso-whatsapp-sessions-snapshot.test.sh"]
      : selectedCell === "lumen"
        ? ["scripts/ops/lumen-postgres-hooks.test.sh"]
        : selectedCell === "nova"
          ? ["scripts/ops/nova-postgres-hooks.test.sh", "scripts/ops/nova-documents-snapshot.test.sh"]
          : allTestScripts;
const nodeTests =
  selectedCell === "platform" || selectedCell === "access" || selectedCell === "audit"
    ? ["scripts/ops/run-platform-postgres-recovery-drill.test.mjs"]
    : selectedCell === "pulso"
      ? [
          "scripts/ops/run-pulso-postgres-recovery-drill.test.mjs",
          "scripts/ops/verify-pulso-postgres-recovery-evidence.test.mjs",
          "scripts/ops/verify-pulso-rollback.test.mjs",
          "scripts/ops/run-pulso-whatsapp-recovery-drill.test.mjs"
        ]
      : selectedCell === "lumen"
        ? ["scripts/ops/run-lumen-postgres-recovery-drill.test.mjs", "scripts/ops/verify-lumen-rollback.test.mjs"]
        : selectedCell === "nova"
          ? allNodeTests.filter((test) => !test.includes("lumen") && !test.includes("pulso"))
          : allNodeTests;
const configuredBash = process.env.HYPERION_BASH?.trim();
const candidates = [
  configuredBash,
  ...(process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe"] : []),
  "bash"
].filter(Boolean);

function runWithBash(bashPath, script) {
  for (const relativePath of [
    script,
    "scripts/ops/postgres-backup.sh",
    "scripts/ops/postgres-restore.sh",
    "scripts/ops/access-postgres-backup.sh",
    "scripts/ops/access-postgres-restore.sh",
    "scripts/ops/audit-postgres-backup.sh",
    "scripts/ops/audit-postgres-restore.sh",
    "scripts/ops/platform-postgres-hooks.test.sh",
    "scripts/ops/nova-postgres-backup.sh",
    "scripts/ops/nova-postgres-restore.sh",
    "scripts/ops/nova-documents-snapshot.sh",
    "scripts/ops/lumen-postgres-backup.sh",
    "scripts/ops/lumen-postgres-restore.sh",
    "scripts/ops/pulso-postgres-backup.sh",
    "scripts/ops/pulso-postgres-restore.sh",
    "scripts/ops/pulso-whatsapp-sessions-snapshot.sh",
    "scripts/ops/postgres-offsite-copy.sh"
  ]) {
    chmodSync(resolve(repositoryRoot, relativePath), 0o755);
  }
  return spawnSync(bashPath, [script], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit"
  });
}

let selectedBash = null;
for (const candidate of candidates) {
  if (candidate.includes("\\") && !existsSync(candidate)) continue;
  let selected = null;
  for (const script of testScripts) {
    const result = runWithBash(candidate, script);
    if (result.error?.code === "ENOENT") {
      selected = null;
      break;
    }
    if (result.error) {
      process.stderr.write(`Unable to execute ${candidate}: ${result.error.message}\n`);
      process.exit(1);
    }
    if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
    selected = candidate;
  }
  if (selected) {
    selectedBash = selected;
    break;
  }
}

if (!selectedBash) {
  process.stderr.write("Bash 4+ is required to run the production backup/restore tests.\n");
  process.exit(1);
}

const operationsTests = spawnSync(process.execPath, ["--test", ...nodeTests], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit"
});
if (operationsTests.error) {
  process.stderr.write(`Unable to run PostgreSQL recovery tests: ${operationsTests.error.message}\n`);
  process.exit(1);
}
process.exit(operationsTests.status ?? 1);

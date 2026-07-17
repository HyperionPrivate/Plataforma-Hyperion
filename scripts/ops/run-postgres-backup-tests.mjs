import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const testScripts = ["scripts/ops/postgres-backup.test.sh", "scripts/ops/postgres-restore.test.sh"];
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
  if (selected) process.exit(0);
}

process.stderr.write("Bash 4+ is required to run the production backup/restore tests.\n");
process.exit(1);

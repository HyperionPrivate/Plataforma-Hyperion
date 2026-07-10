import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const testScript = "scripts/ops/postgres-backup.test.sh";
const configuredBash = process.env.HYPERION_BASH?.trim();
const candidates = [
  configuredBash,
  ...(process.platform === "win32" ? ["C:\\Program Files\\Git\\bin\\bash.exe"] : []),
  "bash"
].filter(Boolean);

for (const candidate of candidates) {
  if (candidate.includes("\\") && !existsSync(candidate)) continue;
  const result = spawnSync(candidate, [testScript], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error?.code === "ENOENT") continue;
  if (result.error) {
    process.stderr.write(`Unable to execute ${candidate}: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

process.stderr.write("Bash 4+ is required to run the production backup tests.\n");
process.exit(1);

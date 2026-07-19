import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeRepoPath } from "../architecture/cell-policy.mjs";
import { changedFilesFromGit } from "./resolve-cell-impact.mjs";

const EXACT_FILES = new Set([
  ".github/workflows/access-channel-projection.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "scripts/architecture/cell-policy.mjs",
  "scripts/autonomy/access-channel-projection.e2e.mjs",
  "scripts/autonomy/access-channel-projection.test.mjs",
  "scripts/ci/cell-install-plan.mjs",
  "scripts/ci/cell-install-plan.test.mjs",
  "scripts/ci/resolve-access-channel-impact.mjs",
  "scripts/ci/resolve-access-channel-impact.test.mjs",
  "scripts/ci/resolve-cell-impact.mjs",
  "scripts/ci/resolve-cell-impact.test.mjs"
]);

const COMPILED_PACKAGE_DIRECTORIES = Object.freeze([
  "packages/access-migrations",
  "packages/config",
  "packages/database",
  "packages/durable-events",
  "packages/logger",
  "packages/platform-contracts",
  "packages/pulso-contracts",
  "packages/pulso-migrations",
  "packages/service-runtime"
]);

const COMPILED_SERVICE_DIRECTORIES = Object.freeze(["services/identity-service", "services/whatsapp-channel-service"]);

function compiledClosureReason(normalized) {
  for (const directory of [...COMPILED_PACKAGE_DIRECTORIES, ...COMPILED_SERVICE_DIRECTORIES]) {
    if (normalized === `${directory}/package.json` || normalized === `${directory}/tsconfig.json`) {
      return `${normalized} configures a package in the compiled Access→Channel closure`;
    }
    if (normalized.startsWith(`${directory}/src/`)) {
      return `${normalized} is compiled in the Access→Channel producer or consumer closure`;
    }
  }

  for (const directory of ["packages/access-migrations", "packages/pulso-migrations"]) {
    if (normalized.startsWith(`${directory}/sql/`)) {
      return `${normalized} is executed while provisioning the Access→Channel databases`;
    }
  }
  return undefined;
}

export function accessChannelBoundaryReason(relativePath) {
  const normalized = normalizeRepoPath(relativePath);
  if (!normalized) return undefined;
  if (EXACT_FILES.has(normalized)) return `${normalized} is part of the Access→Channel acceptance closure`;
  return compiledClosureReason(normalized);
}

export function resolveAccessChannelImpact(changedFiles, options = {}) {
  if (options.forceAll === true) {
    return {
      affected: true,
      changedFiles: [],
      reasons: ["no reliable base revision; fail-safe Access→Channel boundary acceptance"]
    };
  }
  const normalized = [...new Set(changedFiles.map(normalizeRepoPath).filter(Boolean))].sort();
  const reasons = normalized.map(accessChannelBoundaryReason).filter(Boolean);
  return { affected: reasons.length > 0, changedFiles: normalized, reasons };
}

function parseArguments(argv) {
  const options = { changedFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base") options.base = argv[++index];
    else if (argument === "--head") options.head = argv[++index];
    else if (argument === "--changed-file") options.changedFiles.push(argv[++index]);
    else if (argument === "--github-output") options.githubOutput = argv[++index];
    else if (argument === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  let changedFiles = options.changedFiles;
  let forceAll = false;
  if (changedFiles.length === 0) {
    const fromGit = changedFilesFromGit(process.cwd(), options.base, options.head);
    if (fromGit === null) forceAll = true;
    else changedFiles = fromGit;
  }
  const impact = resolveAccessChannelImpact(changedFiles, { forceAll });
  if (options.githubOutput) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(options.githubOutput, `affected=${impact.affected}\n`);
  }
  if (options.json) process.stdout.write(`${JSON.stringify(impact, null, 2)}\n`);
  else
    process.stdout.write(
      `access-channel: ${impact.affected ? "affected" : "not affected"} (${impact.reasons.join("; ") || "no boundary path changed"})\n`
    );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

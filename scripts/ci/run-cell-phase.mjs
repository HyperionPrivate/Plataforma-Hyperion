import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertCell, discoverPackages, normalizeRepoPath } from "../architecture/cell-policy.mjs";

const PHASES = new Set(["lint", "typecheck", "unit", "integration", "build"]);
const STANDALONE_PACKAGES = new Set(["apps/coopfuturo-console"]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:c|m)?(?:j|t)sx?$/;
const INTEGRATION_TEST_PATTERN = /(?:\.integration|\.e2e)\.(?:test|spec)\.(?:c|m)?(?:j|t)sx?$/;

async function walk(root) {
  const files = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (![".next", "coverage", "dist", "node_modules"].includes(entry.name)) {
        files.push(...(await walk(path.join(root, entry.name))));
      }
    } else if (entry.isFile()) files.push(path.join(root, entry.name));
  }
  return files;
}

function pnpmExecutable() {
  return process.platform === "win32" ? "pnpm.exe" : "pnpm";
}

function pnpmFilteredCommand(packageNames, script) {
  const args = [];
  for (const packageName of packageNames) args.push("--filter", `${packageName}...`);
  args.push("--if-present", "run", script);
  return { command: pnpmExecutable(), args };
}

export async function createCellPhasePlan(root, cell, phase) {
  assertCell(cell);
  if (!PHASES.has(phase)) throw new Error(`Unknown phase ${JSON.stringify(phase)}`);

  const packages = (await discoverPackages(root)).filter(
    (entry) => entry.cell === cell && !STANDALONE_PACKAGES.has(entry.directory)
  );
  const packageNames = packages.map((entry) => entry.name).filter(Boolean);
  const commands = [];

  if (phase === "lint") {
    const directories = packages.map((entry) => entry.directory);
    if (directories.length > 0) {
      commands.push({ command: pnpmExecutable(), args: ["exec", "eslint", ...directories] });
      commands.push({ command: pnpmExecutable(), args: ["exec", "prettier", "--check", ...directories] });
    }
  } else if (phase === "typecheck") {
    if (packageNames.length > 0) {
      // Workspace packages publish types from dist/. A clean CI checkout must
      // materialize the selected dependency closure before tsc can typecheck a
      // consumer without relying on stale local artifacts.
      commands.push(pnpmFilteredCommand(packageNames, "build"));
      commands.push(pnpmFilteredCommand(packageNames, "typecheck"));
    }
  } else if (phase === "build") {
    if (packageNames.length > 0) commands.push(pnpmFilteredCommand(packageNames, "build"));
  } else if (phase === "unit") {
    if (packageNames.length > 0) commands.push(pnpmFilteredCommand(packageNames, "test"));
  } else if (phase === "integration") {
    for (const packageEntry of packages) {
      const testFiles = (await walk(packageEntry.absoluteDirectory))
        .filter((filePath) => TEST_FILE_PATTERN.test(filePath) && INTEGRATION_TEST_PATTERN.test(filePath))
        .map((filePath) => normalizeRepoPath(path.relative(packageEntry.absoluteDirectory, filePath)))
        .sort();
      if (testFiles.length === 0 || !packageEntry.name) continue;
      commands.push({
        command: pnpmExecutable(),
        args: ["--filter", packageEntry.name, "exec", "vitest", "run", ...testFiles, "--passWithNoTests"]
      });
    }
  }

  return { cell, phase, packages: packageNames.sort(), commands };
}

function formatCommand(command) {
  return [
    command.command,
    ...command.args.map((argument) => (/[\s"']/.test(argument) ? JSON.stringify(argument) : argument))
  ].join(" ");
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cell") options.cell = argv[++index];
    else if (argument === "--phase") options.phase = argv[++index];
    else if (argument === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.cell || !options.phase) throw new Error("Usage: run-cell-phase.mjs --cell <cell> --phase <phase>");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = await createCellPhasePlan(process.cwd(), options.cell, options.phase);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Cell ${plan.cell} / ${plan.phase}: ${plan.packages.join(", ") || "no workspace packages"}\n`);
  if (plan.commands.length === 0) {
    process.stdout.write(`No ${plan.phase} command is required for this cell.\n`);
    return;
  }

  for (const command of plan.commands) {
    process.stdout.write(`> ${formatCommand(command)}\n`);
    const result = spawnSync(command.command, command.args, { cwd: process.cwd(), stdio: "inherit", shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

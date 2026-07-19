#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertCell, discoverPackages } from "../architecture/cell-policy.mjs";

const STANDALONE_DIRECTORIES = new Set(["apps/coopfuturo-console"]);

export async function createCellInstallPlan(root, cell, requestedRootPackages = []) {
  assertCell(cell);
  const packages = await discoverPackages(root);
  const workspacePackages = packages.filter((entry) => !STANDALONE_DIRECTORIES.has(entry.directory));
  const packagesByName = new Map();

  for (const packageEntry of workspacePackages) {
    if (!packageEntry.name) throw new Error(`Workspace package ${packageEntry.directory} must have a name`);
    if (packagesByName.has(packageEntry.name)) throw new Error(`Duplicate workspace package name ${packageEntry.name}`);
    packagesByName.set(packageEntry.name, packageEntry);
  }

  const cellPackages = workspacePackages.filter((entry) => entry.cell === cell);
  const requested = [...new Set(requestedRootPackages)].sort();
  const roots =
    requested.length === 0
      ? cellPackages
      : requested.map((packageName) => {
          const packageEntry = packagesByName.get(packageName);
          if (!packageEntry) throw new Error(`Requested install root ${packageName} is not a workspace package`);
          if (packageEntry.cell !== cell) {
            throw new Error(
              `Requested install root ${packageName} belongs to ${packageEntry.cell ?? "no cell"}, not ${cell}`
            );
          }
          return packageEntry;
        });

  if (roots.length === 0) throw new Error(`Cell ${cell} has no pnpm workspace packages`);

  const selectedNames = new Set();
  const queue = roots.map((entry) => entry.name);
  while (queue.length > 0) {
    const packageName = queue.shift();
    if (selectedNames.has(packageName)) continue;
    selectedNames.add(packageName);
    const packageEntry = packagesByName.get(packageName);
    if (!packageEntry) continue;

    for (const dependencyName of packageEntry.dependencyNames) {
      const dependency = packagesByName.get(dependencyName);
      if (!dependency) continue;
      if (dependency.cell && dependency.cell !== cell && dependency.cell !== "platform") {
        throw new Error(
          `Cell ${cell} install closure crosses into sibling ${dependency.cell}: ${packageName} -> ${dependencyName}`
        );
      }
      queue.push(dependencyName);
    }
  }

  const rootPackages = roots.map((entry) => entry.name).sort();
  const filters = rootPackages.map((packageName) => `${packageName}...`);
  const args = ["install", "--frozen-lockfile", "--filter", "."];
  for (const filter of filters) args.push("--filter", filter);

  return {
    cell,
    rootImporter: ".",
    rootPackages,
    dependencyClosure: [...selectedNames].sort(),
    excludedStandalone: packages
      .filter((entry) => STANDALONE_DIRECTORIES.has(entry.directory) && entry.cell === cell)
      .map((entry) => entry.directory)
      .sort(),
    filters,
    command: { executable: pnpmExecutable(), args }
  };
}

function pnpmExecutable() {
  return process.platform === "win32" ? "pnpm.exe" : "pnpm";
}

function parseArguments(argv) {
  const options = { requestedRootPackages: [], format: "json", execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cell") options.cell = argv[++index];
    else if (argument === "--package") options.requestedRootPackages.push(argv[++index]);
    else if (argument === "--format") options.format = argv[++index];
    else if (argument === "--execute") options.execute = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.cell) throw new Error("--cell is required");
  if (options.execute && options.format !== "json") throw new Error("--execute cannot be combined with --format");
  if (!new Set(["json", "lines", "command"]).has(options.format)) {
    throw new Error("--format must be json, lines, or command");
  }
  return options;
}

function formatCommand(command) {
  return [
    command.executable,
    ...command.args.map((argument) => (/[^A-Za-z0-9_./:@-]/.test(argument) ? JSON.stringify(argument) : argument))
  ].join(" ");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = await createCellInstallPlan(process.cwd(), options.cell, options.requestedRootPackages);
  if (options.execute) {
    process.stdout.write(`Installing ${plan.cell} workspace closure: ${formatCommand(plan.command)}\n`);
    const result = spawnSync(plan.command.executable, plan.command.args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    return;
  }
  if (options.format === "lines") process.stdout.write(`${plan.filters.join("\n")}\n`);
  else if (options.format === "command") process.stdout.write(`${formatCommand(plan.command)}\n`);
  else process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

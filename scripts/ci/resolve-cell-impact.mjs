import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CELL_NAMES,
  assertCell,
  directCellsForPath,
  discoverPackages,
  normalizeRepoPath,
  packageForPath
} from "../architecture/cell-policy.mjs";
import { validateWorkspaceDependencyGraph } from "../architecture/workspace-dependency-graph.mjs";

const ZERO_SHA = /^0+$/;

export async function resolveCellImpact(root, changedFiles) {
  const packages = await discoverPackages(root);
  await validateWorkspaceDependencyGraph(root, packages);
  const packagesByName = new Map(packages.filter((entry) => entry.name).map((entry) => [entry.name, entry]));
  const dependents = new Map(packages.map((entry) => [entry.name, new Set()]));

  for (const packageEntry of packages) {
    for (const dependencyName of packageEntry.dependencyNames) {
      if (packagesByName.has(dependencyName)) dependents.get(dependencyName)?.add(packageEntry.name);
    }
  }

  const normalizedFiles = [...new Set(changedFiles.map(normalizeRepoPath).filter(Boolean))].sort();
  const affectedCells = new Set();
  const changedPackages = new Set();
  const reasons = new Map(CELL_NAMES.map((cell) => [cell, new Set()]));

  for (const changedFile of normalizedFiles) {
    const packageEntry = packageForPath(packages, changedFile);
    if (packageEntry?.name) {
      changedPackages.add(packageEntry.name);
      if (packageEntry.cell) {
        affectedCells.add(packageEntry.cell);
        reasons.get(packageEntry.cell)?.add(`${changedFile} belongs to ${packageEntry.name}`);
      }
      continue;
    }

    const directCells = directCellsForPath(changedFile);
    // A deleted generic packages/* importer is absent from the current graph,
    // so its former reverse dependencies cannot be reconstructed here. Treat
    // that unknown shared-package path as global instead of silently scanning
    // only platform. Existing importers still use the precise graph above.
    const conservativeCells =
      /^packages\/[^/]+\//.test(changedFile) && directCells.length === 1 && directCells[0] === "platform"
        ? CELL_NAMES
        : directCells;
    for (const cell of conservativeCells) {
      affectedCells.add(cell);
      reasons.get(cell)?.add(`${changedFile} is ${cell === "platform" ? "platform or shared" : `${cell}-owned`}`);
    }
  }

  const affectedPackages = new Set(changedPackages);
  const queue = [...changedPackages];
  while (queue.length > 0) {
    const packageName = queue.shift();
    for (const dependentName of dependents.get(packageName) ?? []) {
      if (affectedPackages.has(dependentName)) continue;
      affectedPackages.add(dependentName);
      queue.push(dependentName);
      const dependent = packagesByName.get(dependentName);
      if (dependent?.cell) {
        affectedCells.add(dependent.cell);
        reasons.get(dependent.cell)?.add(`${dependent.name} depends on changed ${packageName}`);
      }
    }
  }

  return {
    changedFiles: normalizedFiles,
    changedPackages: [...changedPackages].sort(),
    affectedPackages: [...affectedPackages].sort(),
    cells: Object.fromEntries(CELL_NAMES.map((cell) => [cell, affectedCells.has(cell)])),
    reasons: Object.fromEntries(CELL_NAMES.map((cell) => [cell, [...reasons.get(cell)].sort()]))
  };
}

export function changedFilesFromNameStatus(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changedFiles = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!/^[ACDMR][0-9]*$/.test(status)) {
      throw new Error(`Unexpected git diff status record: ${JSON.stringify(status)}`);
    }
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    if (index + pathCount > fields.length) {
      throw new Error(`Truncated git diff status record for ${status}`);
    }
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
      const changedFile = fields[index++];
      if (!changedFile) throw new Error(`Empty path in git diff status record for ${status}`);
      changedFiles.push(changedFile);
    }
  }

  return [...new Set(changedFiles)];
}

export function changedFilesFromGit(root, base, head) {
  if (!base || !head || ZERO_SHA.test(base)) return null;
  const output = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", "--find-copies", "--diff-filter=ACMRD", base, head],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"]
    }
  );
  return changedFilesFromNameStatus(output);
}

function parseArguments(argv) {
  const result = { changedFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cell") result.cell = argv[++index];
    else if (argument === "--base") result.base = argv[++index];
    else if (argument === "--head") result.head = argv[++index];
    else if (argument === "--changed-file") result.changedFiles.push(argv[++index]);
    else if (argument === "--github-output") result.githubOutput = argv[++index];
    else if (argument === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (result.cell) assertCell(result.cell);
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = process.cwd();
  let changedFiles = options.changedFiles;
  let forceAll = false;

  if (changedFiles.length === 0) {
    const fromGit = changedFilesFromGit(root, options.base, options.head);
    if (fromGit === null) forceAll = true;
    else changedFiles = fromGit;
  }

  const impact = forceAll
    ? {
        changedFiles: [],
        changedPackages: [],
        affectedPackages: [],
        cells: Object.fromEntries(CELL_NAMES.map((cell) => [cell, true])),
        reasons: Object.fromEntries(
          CELL_NAMES.map((cell) => [cell, ["no reliable base revision; fail-safe all cells"]])
        )
      }
    : await resolveCellImpact(root, changedFiles);

  if (options.githubOutput) {
    const { appendFileSync } = await import("node:fs");
    const selectedCells = options.cell ? [options.cell] : CELL_NAMES;
    for (const cell of selectedCells) appendFileSync(options.githubOutput, `${cell}=${impact.cells[cell]}\n`);
    if (options.cell) appendFileSync(options.githubOutput, `affected=${impact.cells[options.cell]}\n`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(impact, null, 2)}\n`);
    return;
  }

  const selectedCells = options.cell ? [options.cell] : CELL_NAMES;
  for (const cell of selectedCells) {
    const detail = impact.reasons[cell].join("; ") || "no dependency or owned path changed";
    process.stdout.write(`${cell}: ${impact.cells[cell] ? "affected" : "not affected"} (${detail})\n`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

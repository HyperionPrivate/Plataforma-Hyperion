#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CELL_NAMES } from "../architecture/cell-policy.mjs";
import { changedFilesFromGit, resolveCellImpact } from "./resolve-cell-impact.mjs";

export async function resolveContainerScanPlan(root, options = {}) {
  let forceAll = options.forceAll === true;
  let changedFiles = options.changedFiles ?? [];
  if (!forceAll && changedFiles.length === 0) {
    const fromGit = changedFilesFromGit(root, options.base, options.head);
    if (fromGit === null) forceAll = true;
    else changedFiles = fromGit;
  }

  const affectedCells = forceAll
    ? [...CELL_NAMES]
    : CELL_NAMES.filter((cell) => (options.impact ?? null)?.cells?.[cell]);
  if (!forceAll && !options.impact) {
    const impact = await resolveCellImpact(root, changedFiles);
    affectedCells.splice(0, affectedCells.length, ...CELL_NAMES.filter((cell) => impact.cells[cell]));
  }

  return {
    schemaVersion: 1,
    forceAll,
    changedFiles: [...new Set(changedFiles)].sort(),
    affectedCells,
    matrix: { include: affectedCells.map((cell) => ({ cell })) },
    hasCells: affectedCells.length > 0
  };
}

function parseArguments(argv) {
  const options = { changedFiles: [], forceAll: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base") options.base = argv[++index];
    else if (argument === "--head") options.head = argv[++index];
    else if (argument === "--changed-file") options.changedFiles.push(argv[++index]);
    else if (argument === "--all") options.forceAll = true;
    else if (argument === "--github-output") options.githubOutput = argv[++index];
    else if (argument === "--json") options.json = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = await resolveContainerScanPlan(process.cwd(), options);
  if (options.githubOutput) {
    appendFileSync(options.githubOutput, `matrix=${JSON.stringify(plan.matrix)}\n`);
    appendFileSync(options.githubOutput, `has_cells=${plan.hasCells}\n`);
    appendFileSync(options.githubOutput, `affected_cells=${plan.affectedCells.join(",")}\n`);
  }
  if (options.json || !options.githubOutput) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const CELLS = new Set(["platform", "nova", "lumen", "pulso"]);

export function evaluateRequiredCellResult({ cell, impactResult, affected, cellResult }) {
  if (!CELLS.has(cell)) return { ok: false, reason: "unknown cell" };
  if (impactResult !== "success") {
    return { ok: false, reason: `impact job did not succeed (${impactResult || "missing"})` };
  }
  if (affected === "true" && cellResult === "success") {
    return { ok: true, reason: "affected cell completed successfully" };
  }
  if (affected === "false" && cellResult === "skipped") {
    return { ok: true, reason: "unaffected cell was intentionally skipped" };
  }
  return {
    ok: false,
    reason: `invalid impact/cell outcome (affected=${affected || "missing"}, cell=${cellResult || "missing"})`
  };
}

function main(environment = process.env) {
  const verdict = evaluateRequiredCellResult({
    cell: environment.CELL,
    impactResult: environment.IMPACT_RESULT,
    affected: environment.AFFECTED,
    cellResult: environment.CELL_RESULT
  });
  const prefix = verdict.ok ? "Required cell gate accepted" : "Required cell gate rejected";
  process[verdict.ok ? "stdout" : "stderr"].write(`${prefix}: ${verdict.reason}\n`);
  if (!verdict.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

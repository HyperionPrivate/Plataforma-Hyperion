import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runRollbackCli, verifyCellRollback } from "./verify-cell-rollback-core.mjs";

export function verifyNovaRollback(options, root) {
  return verifyCellRollback("nova", options, root);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runRollbackCli("nova").catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

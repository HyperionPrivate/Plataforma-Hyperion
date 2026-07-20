#!/usr/bin/env node
/**
 * Dry-run gate for DEBT-021 / DEBT-024: proves the publish path exists without
 * inventing registry credentials. Exit 0 when workflow + publication tests are
 * wired; exit 1 on structural gaps.
 */
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const problems = [];

async function mustExist(relativePath) {
  try {
    await access(path.join(root, relativePath));
  } catch {
    problems.push(`missing ${relativePath}`);
  }
}

await mustExist(".github/workflows/publish-shared-libraries.yml");
await mustExist("scripts/releases/shared-library-publication.test.mjs");
await mustExist("docs/operations/REGISTRY-PUBLISH-PATH.md");

const workflow = await readFile(path.join(root, ".github/workflows/publish-shared-libraries.yml"), "utf8");
if (!/workflow_dispatch:/.test(workflow)) {
  problems.push("publish-shared-libraries.yml must remain workflow_dispatch-gated until registry credentials exist");
}
if (/^\s*push:\s*$/m.test(workflow) || /^\s*schedule:\s*$/m.test(workflow)) {
  problems.push("publish-shared-libraries.yml must not auto-publish on push/schedule while DEBT-024 is open");
}

const rootPkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (rootPkg.scripts?.["release:verify-registry-path"] !== "node scripts/releases/verify-registry-publish-path.mjs") {
  problems.push('package.json must expose "release:verify-registry-path"');
}

if (problems.length > 0) {
  console.error(`Registry publish path verification failed:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

console.log(
  "Registry publish path OK (dry-run): workflow_dispatch publish path present; credentials remain out-of-repo (DEBT-021/024)."
);

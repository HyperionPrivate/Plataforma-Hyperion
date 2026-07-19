import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("nova-migrations build produces every one-shot artifact referenced by Compose", () => {
  const executable = process.platform === "win32" ? "pnpm.exe" : "pnpm";
  const result = spawnSync(executable, ["--filter", "@hyperion/nova-migrations", "build"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const compose = readFileSync(path.join(repositoryRoot, "infra/docker-compose.yml"), "utf8");
  const referenced = [...compose.matchAll(/packages\/nova-migrations\/dist\/([a-z-]+\.js)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(referenced)].sort(), ["bootstrap-database.js", "bootstrap-roles.js", "index.js"]);

  for (const artifact of new Set(referenced)) {
    const source = path.join(repositoryRoot, "packages/nova-migrations/src", artifact.replace(/\.js$/, ".ts"));
    const output = path.join(repositoryRoot, "packages/nova-migrations/dist", artifact);
    assert.equal(existsSync(source), true, `missing source entrypoint for ${artifact}`);
    assert.equal(existsSync(output), true, `build did not produce ${artifact}`);
  }
});

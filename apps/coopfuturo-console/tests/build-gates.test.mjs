import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJsonUrl = new URL("../package.json", import.meta.url);
const nextConfigUrl = new URL("../next.config.ts", import.meta.url);

test("the customer console exposes real lint, typecheck, test, and build gates", async () => {
  const manifest = JSON.parse(await readFile(packageJsonUrl, "utf8"));

  assert.match(manifest.scripts.lint, /--max-warnings 0/);
  assert.match(manifest.scripts.typecheck, /tsc/);
  assert.match(manifest.scripts.test, /node --test/);
  assert.match(manifest.scripts.check, /lint.*typecheck.*test.*build/);
});

test("Next.js cannot publish when lint or TypeScript reports errors", async () => {
  const config = await readFile(nextConfigUrl, "utf8");

  assert.doesNotMatch(config, /ignoreDuringBuilds/);
  assert.doesNotMatch(config, /ignoreBuildErrors/);
});

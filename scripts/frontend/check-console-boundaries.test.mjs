import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bundleCheckerBuildViolation,
  dedicatedDevBffTargetViolation,
  isConsoleBoundaryFile,
  legacyMultiproductSelectorViolation,
  sharedBundleProvenanceViolation,
  walkConsoleBoundaryFiles
} from "./check-console-boundaries.mjs";

test("development proxies default to the owning BFF instead of the global gateway", () => {
  assert.equal(
    dedicatedDevBffTargetViolation('const target = process.env.NOVA_BFF_DEV_TARGET ?? "http://127.0.0.1:8095";', 8095),
    undefined
  );
  assert.match(
    dedicatedDevBffTargetViolation('const target = process.env.NOVA_BFF_DEV_TARGET ?? "http://127.0.0.1:8080";', 8095),
    /cell BFF/
  );
  assert.match(dedicatedDevBffTargetViolation("export default {};", 8095), /missing explicit/);
});

test("recognizes config, package, HTML and Docker inputs outside src", () => {
  for (const file of ["vite.config.ts", "package.json", "index.html", "Dockerfile", "deploy.yaml"]) {
    assert.equal(isConsoleBoundaryFile(file), true, file);
  }
  assert.equal(isConsoleBoundaryFile("hero.png"), false);
});

test("rejects legacy environment selectors and explicit all-products modes", () => {
  for (const source of [
    "const product = import.meta.env.VITE_PRODUCT",
    "ARG VITE_PRODUCT=all",
    '{"build":"VITE_BRAND_LABEL=customer vite build"}',
    "window.config = { productMode: 'all' }"
  ]) {
    assert.ok(legacyMultiproductSelectorViolation(source), source);
  }
  assert.equal(legacyMultiproductSelectorViolation("const product = 'lumen'"), undefined);
});

test("requires the bundle verifier in build after Vite, not in an unrelated script", () => {
  assert.equal(bundleCheckerBuildViolation("tsc --noEmit && vite build && node scripts/check-bundle.mjs"), undefined);
  assert.match(bundleCheckerBuildViolation("vite build"), /must run/);
  assert.match(bundleCheckerBuildViolation("node scripts/check-bundle.mjs && vite build"), /after/);
  assert.match(bundleCheckerBuildViolation(undefined), /must run/);
  assert.equal(
    bundleCheckerBuildViolation("next build --turbopack && node scripts/check-bundle.mjs --emit", "next"),
    undefined
  );
  assert.match(bundleCheckerBuildViolation("next build --turbopack", "next"), /after the Next build/);
});

test("requires both halves of shared bundle provenance integration", () => {
  const vite = 'import { createViteBundleProvenancePlugin } from "@hyperion/frontend-build-provenance";';
  const checker = 'import { verifyConsoleBundle } from "@hyperion/frontend-build-provenance";';
  assert.equal(sharedBundleProvenanceViolation(vite, checker), undefined);
  assert.match(sharedBundleProvenanceViolation("plugins: []", checker), /Vite must emit/);
  assert.match(sharedBundleProvenanceViolation(vite, "console.log('ok')"), /must verify/);
});

test("walks boundary files across the console root while excluding generated trees", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hyperion-console-boundary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "foreign"), { recursive: true });
  await writeFile(path.join(root, "src", "main.ts"), "export {};\n");
  await writeFile(path.join(root, "vite.config.ts"), "export default {};\n");
  await writeFile(path.join(root, "index.html"), "<main></main>\n");
  await writeFile(path.join(root, "Dockerfile"), "FROM scratch\n");
  await writeFile(path.join(root, "node_modules", "foreign", "package.json"), "{}\n");

  const files = (await walkConsoleBoundaryFiles(root)).map((file) => path.relative(root, file).replaceAll("\\", "/"));
  assert.deepEqual(files.sort(), ["Dockerfile", "index.html", "src/main.ts", "vite.config.ts"]);
});

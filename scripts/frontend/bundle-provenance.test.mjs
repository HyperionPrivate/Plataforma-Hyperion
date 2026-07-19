import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { LUMEN_BUNDLE_POLICY, verifyLumenBundle } from "../../apps/lumen-console/scripts/check-bundle.mjs";
import {
  PLATFORM_ADMIN_BUNDLE_POLICY,
  verifyPlatformAdminBundle
} from "../../apps/platform-admin-console/scripts/check-bundle.mjs";
import { PULSO_BUNDLE_POLICY, verifyPulsoBundle } from "../../apps/pulso-console/scripts/check-bundle.mjs";

const cases = [
  {
    name: "LUMEN",
    policy: LUMEN_BUNDLE_POLICY,
    verify: verifyLumenBundle,
    foreignModule: "workspace:apps/nova-console/src/components/NeutralCard.tsx",
    foreignDependency:
      "workspace:node_modules/.pnpm/@hyperion+nova-contracts@1.1.0/node_modules/@hyperion/nova-contracts/dist/index.js",
    foreignChunk: "assets/nova-feature.js"
  },
  {
    name: "PULSO",
    policy: PULSO_BUNDLE_POLICY,
    verify: verifyPulsoBundle,
    foreignModule: "workspace:apps/lumen-console/src/components/NeutralCard.tsx",
    foreignDependency:
      "workspace:node_modules/.pnpm/@hyperion+lumen-contracts@1.1.0/node_modules/@hyperion/lumen-contracts/dist/index.js",
    foreignChunk: "assets/lumen-feature.js"
  },
  {
    name: "Platform admin",
    policy: PLATFORM_ADMIN_BUNDLE_POLICY,
    verify: verifyPlatformAdminBundle,
    foreignModule: "workspace:apps/pulso-console/src/components/NeutralCard.tsx",
    foreignDependency:
      "workspace:node_modules/.pnpm/@hyperion+pulso-contracts@1.1.0/node_modules/@hyperion/pulso-contracts/dist/index.js",
    foreignChunk: "assets/pulso-iris-feature.js"
  }
];

const temporaryRoots = new Set();

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function outputRecord(fileName, contents, overrides = {}) {
  const bytes = Buffer.from(contents);
  return {
    fileName,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    dynamicImports: [],
    facadeModuleId: null,
    imports: [],
    isEntry: false,
    modules: [],
    type: "asset",
    ...overrides
  };
}

async function createValidBundle(entry) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "hyperion-console-provenance-"));
  temporaryRoots.add(temporaryRoot);
  const appDirectory = entry.policy.entryModule.slice("workspace:".length).replace(/\/src\/main\.tsx$/u, "");
  const appRoot = path.join(temporaryRoot, ...appDirectory.split("/"));
  const distRoot = path.join(appRoot, "dist");
  await mkdir(path.join(distRoot, "assets"), { recursive: true });

  const html = '<!doctype html><div id="root"></div>';
  const javascript = "console.log('cell-owned console');";
  await writeFile(path.join(distRoot, "index.html"), html);
  await writeFile(path.join(distRoot, "assets", "index.js"), javascript);

  const reactModule = "workspace:node_modules/.pnpm/react@19.0.0/node_modules/react/index.js";
  const metafile = {
    schemaVersion: 1,
    kind: "vite-rollup-build",
    product: entry.policy.product,
    entryModule: entry.policy.entryModule,
    modules: [
      entry.policy.entryModule,
      reactModule,
      `virtual-file:${reactModule}?commonjs-module`,
      "virtual:vite/modulepreload-polyfill.js"
    ],
    outputs: [
      outputRecord("assets/index.js", javascript, {
        facadeModuleId: entry.policy.entryModule,
        isEntry: true,
        modules: [entry.policy.entryModule, reactModule],
        type: "chunk"
      }),
      outputRecord("index.html", html)
    ]
  };
  await writeMetafile(entry, distRoot, metafile);
  return { appRoot, distRoot, metafile };
}

async function writeMetafile(entry, distRoot, metafile) {
  await writeFile(path.join(distRoot, entry.policy.metafileName), `${JSON.stringify(metafile, null, 2)}\n`, "utf8");
}

test.afterEach(async () => {
  await Promise.all([...temporaryRoots].map((root) => rm(root, { force: true, recursive: true })));
  temporaryRoots.clear();
});

test("accepts complete cell/platform/third-party provenance for every federated console", async (context) => {
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const { appRoot } = await createValidBundle(entry);
      assert.deepEqual(entry.verify({ appRoot }), { chunks: 1, modules: 4, outputs: 2 });
    });
  }
});

test("rejects a foreign workspace module even when it appears only in chunk provenance", async (context) => {
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const { appRoot, distRoot, metafile } = await createValidBundle(entry);
      metafile.outputs[0].modules.push(entry.foreignModule);
      await writeMetafile(entry, distRoot, metafile);
      assert.throws(() => entry.verify({ appRoot }), /outside its cell\/platform allowlist/);
    });
  }
});

test("rejects a provider package owned by another cell through pnpm module paths", async (context) => {
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const { appRoot, distRoot, metafile } = await createValidBundle(entry);
      metafile.modules.push(entry.foreignDependency);
      await writeMetafile(entry, distRoot, metafile);
      assert.throws(() => entry.verify({ appRoot }), /foreign Hyperion dependency/);
    });
  }
});

test("rejects static or dynamic chunk imports omitted from the output inventory", async () => {
  const entry = cases[0];
  const { appRoot, distRoot, metafile } = await createValidBundle(entry);
  metafile.outputs[0].dynamicImports.push("assets/undeclared-lazy.js");
  await writeMetafile(entry, distRoot, metafile);
  assert.throws(() => entry.verify({ appRoot }), /imports undeclared chunk/);
});

test("rejects a declared foreign-cell chunk even when its source is textually neutral", async (context) => {
  for (const entry of cases) {
    await context.test(entry.name, async () => {
      const { appRoot, distRoot, metafile } = await createValidBundle(entry);
      const contents = "console.log('neutral lazy feature');";
      const target = path.join(distRoot, ...entry.foreignChunk.split("/"));
      await writeFile(target, contents);
      metafile.outputs[0].dynamicImports.push(entry.foreignChunk);
      metafile.outputs.push(outputRecord(entry.foreignChunk, contents, { type: "chunk" }));
      await writeMetafile(entry, distRoot, metafile);
      assert.throws(() => entry.verify({ appRoot }), /contains forbidden/);
    });
  }
});

test("rejects emitted files omitted from provenance and bytes changed after hashing", async () => {
  const entry = cases[1];
  const untracked = await createValidBundle(entry);
  await writeFile(path.join(untracked.distRoot, "assets", "untracked.bin"), Buffer.from([0, 1, 2, 3]));
  assert.throws(() => entry.verify({ appRoot: untracked.appRoot }), /output inventory differs from dist/);

  const tampered = await createValidBundle(entry);
  const bundlePath = path.join(tampered.distRoot, "assets", "index.js");
  await writeFile(bundlePath, `${await readFile(bundlePath, "utf8")}\nconsole.log('tampered');`);
  assert.throws(() => entry.verify({ appRoot: tampered.appRoot }), /output integrity does not match/);
});

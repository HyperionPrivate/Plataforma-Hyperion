import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { verifyNovaBundle } from "./check-bundle.mjs";

const temporaryRoots = [];

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function outputRecord(fileName, contents, overrides = {}) {
  const buffer = Buffer.from(contents);
  return {
    fileName,
    bytes: buffer.byteLength,
    sha256: sha256(buffer),
    dynamicImports: [],
    facadeModuleId: null,
    imports: [],
    isEntry: false,
    modules: [],
    type: "asset",
    ...overrides
  };
}

function createValidBundle() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "hyperion-nova-bundle-"));
  temporaryRoots.push(workspaceRoot);
  const appRoot = join(workspaceRoot, "apps", "nova-console");
  const distRoot = join(appRoot, "dist");
  mkdirSync(join(distRoot, "assets"), { recursive: true });

  const html = '<!doctype html><div id="root"></div>';
  const javascript = "console.log('nova console');";
  writeFileSync(join(distRoot, "index.html"), html);
  writeFileSync(join(distRoot, "assets", "index.js"), javascript);

  const mainModule = "workspace:apps/nova-console/src/main.tsx";
  const reactModule = "workspace:node_modules/.pnpm/react@19.0.0/node_modules/react/index.js";
  const metafile = {
    schemaVersion: 1,
    kind: "vite-rollup-build",
    product: "nova",
    entryModule: mainModule,
    modules: [
      mainModule,
      reactModule,
      `virtual-file:${reactModule}?commonjs-module`,
      "virtual:vite/modulepreload-polyfill.js"
    ],
    outputs: [
      outputRecord("assets/index.js", javascript, {
        facadeModuleId: mainModule,
        isEntry: true,
        modules: [mainModule, reactModule],
        type: "chunk"
      }),
      outputRecord("index.html", html)
    ]
  };
  writeFileSync(join(distRoot, "nova-bundle-metafile.json"), `${JSON.stringify(metafile, null, 2)}\n`);
  return { appRoot, distRoot, metafile };
}

function writeMetafile(distRoot, metafile) {
  writeFileSync(join(distRoot, "nova-bundle-metafile.json"), `${JSON.stringify(metafile, null, 2)}\n`);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("NOVA bundle provenance verifier", () => {
  it("accepts a complete NOVA/platform and third-party provenance manifest", () => {
    const { appRoot } = createValidBundle();
    expect(verifyNovaBundle({ appRoot })).toEqual({ modules: 4, outputs: 2 });
  });

  it("rejects a workspace module owned by another product", () => {
    const { appRoot, distRoot, metafile } = createValidBundle();
    metafile.modules.push("workspace:packages/lumen-contracts/dist/index.js");
    writeMetafile(distRoot, metafile);

    expect(() => verifyNovaBundle({ appRoot })).toThrow(/outside the NOVA\/platform allowlist.*lumen-contracts/);
  });

  it("scans emitted asset types beyond JavaScript, CSS, and HTML", () => {
    const { appRoot, distRoot, metafile } = createValidBundle();
    const data = JSON.stringify({ endpoint: "/lumen/v1/clinical" });
    writeFileSync(join(distRoot, "assets", "runtime-data.json"), data);
    metafile.outputs.push(outputRecord("assets/runtime-data.json", data));
    writeMetafile(distRoot, metafile);

    expect(() => verifyNovaBundle({ appRoot })).toThrow(/runtime-data\.json contains forbidden marker.*lumen/i);
  });

  it("rejects an emitted asset omitted from the Rollup inventory", () => {
    const { appRoot, distRoot } = createValidBundle();
    writeFileSync(join(distRoot, "assets", "untracked.bin"), Buffer.from([0, 1, 2, 3]));

    expect(() => verifyNovaBundle({ appRoot })).toThrow(/output inventory differs from dist/);
  });

  it("rejects output content changed after the metafile was generated", () => {
    const { appRoot, distRoot } = createValidBundle();
    const bundlePath = join(distRoot, "assets", "index.js");
    writeFileSync(bundlePath, `${readFileSync(bundlePath, "utf8")}\nconsole.log('changed');`);

    expect(() => verifyNovaBundle({ appRoot })).toThrow(/output integrity does not match/);
  });
});

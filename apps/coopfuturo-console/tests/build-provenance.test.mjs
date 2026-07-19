import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  emitNextBuildProvenance,
  verifyNextBuildProvenance,
} from "../scripts/check-bundle.mjs";

const policy = Object.freeze({
  cell: "nova",
  product: "nova",
  client: "coopfuturo-fixture",
  contextSourceRoot: "apps/coopfuturo-console",
  receiptName: "hyperion-build-provenance.json",
  inputRoots: Object.freeze(["package-lock.json", "package.json", "public", "src"]),
  appRoutes: Object.freeze(["/"]),
  pagesRoutes: Object.freeze([]),
  allowedHyperionDependencies: Object.freeze([]),
});

async function put(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function putJson(root, relativePath, value) {
  await put(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "coopfuturo-next-provenance-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const packageManifest = {
    name: policy.client,
    private: true,
    dependencies: { next: "15.5.20" },
  };
  const packageLock = {
    name: policy.client,
    lockfileVersion: 3,
    packages: {
      "": { name: policy.client, dependencies: { next: "15.5.20" } },
      "node_modules/next": { version: "15.5.20" },
    },
  };
  await putJson(root, "package.json", packageManifest);
  await putJson(root, "package-lock.json", packageLock);
  await put(root, "src/app/page.tsx", "export default function Page() { return <main>Customer</main>; }\n");
  await put(root, "public/logo.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n");
  await putJson(root, "node_modules/next/package.json", { name: "next", version: "15.5.20" });

  await put(root, ".next/BUILD_ID", "fixture-build\n");
  await putJson(root, ".next/required-server-files.json", {
    version: 1,
    config: {
      output: "standalone",
      distDir: ".next",
      outputFileTracingRoot: root,
      turbopack: { root },
    },
    appDir: root,
    relativeAppDir: "",
    files: [".next/BUILD_ID"],
    ignore: [],
  });
  await putJson(root, ".next/app-path-routes-manifest.json", { "/page": "/" });
  await putJson(root, ".next/server/app-paths-manifest.json", { "/page": "app/page.js" });
  await putJson(root, ".next/server/pages-manifest.json", {});
  await putJson(root, ".next/routes-manifest.json", {
    version: 3,
    redirects: [
      {
        source: "/:path+/",
        destination: "/:path+",
        internal: true,
        statusCode: 308,
      },
    ],
    headers: [],
    rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
    staticRoutes: [{ page: "/" }],
    dynamicRoutes: [],
  });
  await putJson(root, ".next/server/middleware-manifest.json", {
    version: 3,
    middleware: {},
    sortedMiddleware: [],
    functions: {},
  });
  await putJson(root, ".next/server/server-reference-manifest.json", {
    node: {},
    edge: {},
    encryptionKey: "fixture",
  });
  await put(root, ".next/server/app/page.js", 'module.exports = "[project]/src/app/page.tsx";\n');
  await putJson(root, ".next/server/app/page.js.nft.json", {
    version: 1,
    files: ["../../../node_modules/next/package.json"],
  });
  const clientReference = {
    moduleLoading: { prefix: "", crossOrigin: null },
    clientModules: {
      "[project]/src/app/page.tsx": {
        id: 1,
        name: "*",
        chunks: ["/_next/static/chunks/app.js"],
        async: false,
      },
    },
    ssrModuleMapping: {},
    edgeSSRModuleMapping: {},
    rscModuleMapping: {},
    edgeRscModuleMapping: {},
  };
  await put(
    root,
    ".next/server/app/page_client-reference-manifest.js",
    `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n` +
      `globalThis.__RSC_MANIFEST[\"/page\"] = ${JSON.stringify(clientReference)};\n`,
  );
  for (const trace of ["next-minimal-server.js.nft.json", "next-server.js.nft.json"]) {
    await putJson(root, `.next/${trace}`, {
      version: 1,
      files: ["../node_modules/next/package.json"],
    });
  }

  await putJson(root, ".next/standalone/package.json", packageManifest);
  await put(root, ".next/standalone/server.js", "process.stdout.write('ready');\n");
  await put(root, ".next/standalone/.next/BUILD_ID", "fixture-build\n");
  await putJson(root, ".next/standalone/node_modules/next/package.json", {
    name: "next",
    version: "15.5.20",
  });
  await put(root, ".next/static/chunks/app.js", "self.__next_f = self.__next_f || [];\n");
  return root;
}

function options(root, overrides = {}) {
  return { appRoot: root, policy, requireContextManifest: false, ...overrides };
}

test("emits and re-verifies a deterministic complete Next deployment inventory", async (context) => {
  const root = await fixture(context);
  const first = emitNextBuildProvenance(options(root));
  const receipt = path.join(root, ".next", "standalone", policy.receiptName);
  const firstContents = await readFile(receipt, "utf8");
  const second = emitNextBuildProvenance(options(root));
  const secondContents = await readFile(receipt, "utf8");

  assert.deepEqual(first, second);
  assert.equal(first.routes, 1);
  assert.equal(first.traces, 3);
  assert.equal(first.packages, 1);
  assert.equal(firstContents, secondContents);
  assert.deepEqual(verifyNextBuildProvenance(options(root)), first);
});

test("rejects bytes changed after hashing and untracked deployment files", async (context) => {
  const root = await fixture(context);
  emitNextBuildProvenance(options(root));
  await put(root, ".next/static/chunks/app.js", "self.__next_f = ['changed'];\n");
  assert.throws(() => verifyNextBuildProvenance(options(root)), /does not match artifact/);

  emitNextBuildProvenance(options(root));
  await put(root, ".next/standalone/untracked.js", "export {};\n");
  assert.throws(() => verifyNextBuildProvenance(options(root)), /does not match artifact/);
});

test("rejects LUMEN or PULSO content even when emitted under a neutral chunk name", async (context) => {
  const root = await fixture(context);
  await put(root, ".next/static/chunks/app.js", 'globalThis.product = "PULSO-IRIS";\n');
  assert.throws(() => emitNextBuildProvenance(options(root)), /forbidden PULSO product marker/);
});

test("rejects a route outside the explicit customer route table", async (context) => {
  const root = await fixture(context);
  await putJson(root, ".next/app-path-routes-manifest.json", { "/page": "/lumen" });
  await putJson(root, ".next/routes-manifest.json", {
    version: 3,
    redirects: [{ source: "/:path+/", destination: "/:path+", internal: true, statusCode: 308 }],
    headers: [],
    rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
    staticRoutes: [{ page: "/lumen" }],
    dynamicRoutes: [],
  });
  assert.throws(() => emitNextBuildProvenance(options(root)), /routes differs from its allowlist/);
});

test("rejects neutral client module provenance outside the isolated project", async (context) => {
  const root = await fixture(context);
  const clientReference = {
    moduleLoading: { prefix: "", crossOrigin: null },
    clientModules: {
      "[project]/../shared-neutral/component.tsx": {
        id: 1,
        name: "*",
        chunks: ["/_next/static/chunks/app.js"],
        async: false,
      },
    },
  };
  await put(
    root,
    ".next/server/app/page_client-reference-manifest.js",
    `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n` +
      `globalThis.__RSC_MANIFEST[\"/page\"] = ${JSON.stringify(clientReference)};\n`,
  );
  assert.throws(() => emitNextBuildProvenance(options(root)), /portable descendant path/);
});

test("rejects NFT traversal even when the referenced file exists", async (context) => {
  const root = await fixture(context);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  context.after(() => rm(outside, { force: true }));
  await writeFile(outside, "neutral\n");
  await putJson(root, ".next/next-server.js.nft.json", {
    version: 1,
    files: [`../../${path.basename(outside)}`],
  });
  assert.throws(() => emitNextBuildProvenance(options(root)), /escapes its declared root/);
});

test("rejects non-allowlisted Hyperion packages in the traced runtime", async (context) => {
  const root = await fixture(context);
  const lockPath = path.join(root, "package-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.packages["node_modules/@hyperion/shared-neutral"] = { version: "1.0.0" };
  await putJson(root, "package-lock.json", lock);
  const packageManifest = { name: "@hyperion/shared-neutral", version: "1.0.0" };
  await putJson(root, "node_modules/@hyperion/shared-neutral/package.json", packageManifest);
  await putJson(root, ".next/standalone/node_modules/@hyperion/shared-neutral/package.json", packageManifest);
  await putJson(root, ".next/next-server.js.nft.json", {
    version: 1,
    files: ["../node_modules/@hyperion/shared-neutral/package.json"],
  });
  assert.throws(() => emitNextBuildProvenance(options(root)), /foreign Hyperion dependency/);
});

test("rejects unexpected middleware, edge functions, and server actions", async (context) => {
  const root = await fixture(context);
  await putJson(root, ".next/server/middleware-manifest.json", {
    version: 3,
    middleware: { "/": { files: [] } },
    sortedMiddleware: ["/"],
    functions: {},
  });
  assert.throws(() => emitNextBuildProvenance(options(root)), /unexpected middleware or edge functions/);

  await putJson(root, ".next/server/middleware-manifest.json", {
    version: 3,
    middleware: {},
    sortedMiddleware: [],
    functions: {},
  });
  await putJson(root, ".next/server/server-reference-manifest.json", {
    node: { action: { workers: {} } },
    edge: {},
    encryptionKey: "fixture",
  });
  assert.throws(() => emitNextBuildProvenance(options(root)), /unexpected server actions/);
});

test("release mode requires the generated customer Docker context receipt", async (context) => {
  const root = await fixture(context);
  assert.throws(
    () => emitNextBuildProvenance(options(root, { requireContextManifest: true })),
    /requires the generated Coopfuturo Docker context manifest/,
  );
});

test("accepts a semantically exact Docker context receipt and rejects stale hashes", async (context) => {
  const root = await fixture(context);
  const inputFiles = [];
  for (const relativePath of ["package-lock.json", "package.json", "public/logo.svg", "src/app/page.tsx"]) {
    const contents = await readFile(path.join(root, ...relativePath.split("/")));
    inputFiles.push({
      path: relativePath,
      source: `${policy.contextSourceRoot}/${relativePath}`,
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  inputFiles.sort((left, right) => left.path.localeCompare(right.path));
  const contextManifest = {
    schemaVersion: 1,
    kind: "customer-console-context",
    cell: policy.cell,
    client: policy.client,
    generatedAt: "2026-07-19T00:00:00.000Z",
    sourceRoot: policy.contextSourceRoot,
    allowlist: policy.inputRoots,
    files: inputFiles,
  };
  await putJson(root, ".context-manifest.json", contextManifest);
  assert.doesNotThrow(() => emitNextBuildProvenance(options(root, { requireContextManifest: true })));

  contextManifest.files[0].sha256 = "0".repeat(64);
  await putJson(root, ".context-manifest.json", contextManifest);
  assert.throws(
    () => emitNextBuildProvenance(options(root, { requireContextManifest: true })),
    /inventory differs from the build inputs/,
  );
});

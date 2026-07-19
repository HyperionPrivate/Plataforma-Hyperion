import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultRepositoryRoot = resolve(import.meta.dirname, "../..");
const ignoredDirectories = new Set([".next", "coverage", "dist", "node_modules"]);
const boundaryExtensions = new Set([".cjs", ".css", ".html", ".js", ".json", ".mjs", ".ts", ".tsx", ".yaml", ".yml"]);
const cells = [
  {
    directory: "apps/coopfuturo-console",
    packageName: "coopfuturo-console",
    requiredDependencies: [],
    bundleCheckerRequired: true,
    bundleBuildTool: "next",
    requiredCheck: /lint.*typecheck.*test.*build/,
    forbidden: [/\blumen\b/i, /\bpulso(?:[-_ ]?iris)?\b/i]
  },
  {
    directory: "apps/nova-console",
    packageName: "@hyperion/nova-console",
    devBffPort: 8095,
    requiredDependencies: ["@hyperion/nova-contracts", "@hyperion/platform-contracts"],
    forbidden: [
      /\blumen\b/i,
      /\bpulso(?:[-_ ]?iris)?\b/i,
      /coopfuturo/i,
      /brand-coopfuturo/i,
      /renovaci[oó]n/i,
      /reactivaci[oó]n/i,
      /microcr[eé]dito/i
    ]
  },
  {
    directory: "apps/lumen-console",
    packageName: "@hyperion/lumen-console",
    devBffPort: 8096,
    sharedBundleProvenance: true,
    requiredDependencies: ["@hyperion/lumen-contracts", "@hyperion/platform-contracts"],
    forbidden: [/\bnova\b/i, /\bpulso(?:[-_ ]?iris)?\b/i, /coopfuturo/i, /brand-coopfuturo/i]
  },
  {
    directory: "apps/pulso-console",
    packageName: "@hyperion/pulso-console",
    devBffPort: 8097,
    sharedBundleProvenance: true,
    requiredDependencies: ["@hyperion/pulso-contracts", "@hyperion/platform-contracts"],
    forbidden: [/\bnova\b/i, /\blumen\b/i, /coopfuturo/i, /brand-coopfuturo/i]
  },
  {
    directory: "apps/platform-admin-console",
    packageName: "@hyperion/platform-admin-console",
    devBffPort: 8098,
    sharedBundleProvenance: true,
    requiredDependencies: ["@hyperion/platform-contracts"],
    forbidden: [/\bnova\b/i, /\blumen\b/i, /\bpulso(?:[-_ ]?iris)?\b/i, /coopfuturo/i, /brand-coopfuturo/i]
  }
];

export function isConsoleBoundaryFile(file) {
  const name = file.replaceAll("\\", "/").split("/").at(-1);
  return name === "Dockerfile" || boundaryExtensions.has(extname(name).toLowerCase());
}

export function legacyMultiproductSelectorViolation(content) {
  if (/\bVITE_(?:PRODUCT|BRAND_LABEL)\b/i.test(content)) return "legacy multiproduct selector";
  if (/\b(?:product|brand)(?:Mode|Profile)?\s*[:=]\s*["']all["']/i.test(content)) {
    return "legacy all-products mode";
  }
  return undefined;
}

export function dedicatedDevBffTargetViolation(content, expectedPort) {
  const match = content.match(/process\.env\.[A-Z0-9_]+\s*\?\?\s*["']([^"']+)["']/);
  if (!match) return "missing explicit cell-owned development BFF default";
  let target;
  try {
    target = new URL(match[1]);
  } catch {
    return "invalid development BFF default";
  }
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.port !== String(expectedPort)) {
    return `development proxy must default to the cell BFF on 127.0.0.1:${expectedPort}`;
  }
  return undefined;
}

export function bundleCheckerBuildViolation(buildScript, buildTool = "vite") {
  const script = String(buildScript ?? "");
  const build = buildTool === "next" ? /\bnext\s+build\b/u.exec(script) : /\bvite\s+build\b/u.exec(script);
  const checker = /\bnode\s+scripts[\\/]check-bundle\.mjs\b/u.exec(script);
  if (!build || !checker || checker.index <= build.index) {
    return `build must run scripts/check-bundle.mjs after the ${buildTool === "next" ? "Next" : "Vite"} build`;
  }
  return undefined;
}

export function sharedBundleProvenanceViolation(viteConfig, checkerSource) {
  if (
    !viteConfig.includes("@hyperion/frontend-build-provenance") ||
    !viteConfig.includes("createViteBundleProvenancePlugin")
  ) {
    return "Vite must emit the shared module/output provenance metafile";
  }
  if (
    !checkerSource.includes("@hyperion/frontend-build-provenance") ||
    !checkerSource.includes("verifyConsoleBundle")
  ) {
    return "bundle checker must verify the shared provenance metafile";
  }
  return undefined;
}

export async function walkConsoleBoundaryFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const target = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkConsoleBoundaryFiles(target)));
    else if (entry.isFile() && isConsoleBoundaryFile(target)) files.push(target);
  }
  return files;
}

export async function checkConsoleBoundaries(repositoryRoot = defaultRepositoryRoot) {
  const violations = [];
  for (const cell of cells) {
    const root = join(repositoryRoot, cell.directory);
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (manifest.name !== cell.packageName) violations.push(`${cell.directory}: package must be ${cell.packageName}`);
    if (manifest.dependencies?.["@hyperion/contracts"]) {
      violations.push(`${cell.directory}: dedicated consoles cannot depend on legacy @hyperion/contracts`);
    }
    for (const dependency of cell.requiredDependencies) {
      if (!manifest.dependencies?.[dependency])
        violations.push(`${cell.directory}: missing provider-owned ${dependency}`);
    }
    if (!manifest.scripts?.build || !manifest.scripts?.test) {
      violations.push(`${cell.directory}: build and test scripts are required`);
    }
    if (cell.bundleCheckerRequired !== false) {
      const checkerViolation = bundleCheckerBuildViolation(manifest.scripts?.build, cell.bundleBuildTool);
      if (checkerViolation) violations.push(`${cell.directory}: ${checkerViolation}`);
    }
    if (cell.requiredCheck && !cell.requiredCheck.test(String(manifest.scripts?.check ?? "")))
      violations.push(`${cell.directory}: check must gate lint, typecheck, test, and build`);

    const boundaryFiles = await walkConsoleBoundaryFiles(root);
    if (cell.devBffPort) {
      const viteConfig = await readFile(join(root, "vite.config.ts"), "utf8");
      const targetViolation = dedicatedDevBffTargetViolation(viteConfig, cell.devBffPort);
      if (targetViolation) violations.push(`${cell.directory}/vite.config.ts: ${targetViolation}`);
      if (cell.sharedBundleProvenance) {
        const checkerSource = await readFile(join(root, "scripts", "check-bundle.mjs"), "utf8");
        const provenanceViolation = sharedBundleProvenanceViolation(viteConfig, checkerSource);
        if (provenanceViolation) violations.push(`${cell.directory}: ${provenanceViolation}`);
      }
    }
    for (const file of boundaryFiles) {
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
      if (relative(root, file).replaceAll("\\", "/") === "scripts/check-bundle.mjs") continue;
      const content = await readFile(file, "utf8");
      const label = relative(repositoryRoot, file).replaceAll("\\", "/");
      const selectorViolation = legacyMultiproductSelectorViolation(content);
      if (selectorViolation) violations.push(`${label}: ${selectorViolation}`);
    }

    const sourceFiles = boundaryFiles.filter(
      (file) =>
        relative(root, file).replaceAll("\\", "/").startsWith("src/") &&
        /\.(css|ts|tsx)$/.test(file) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
    );
    for (const file of sourceFiles) {
      const content = await readFile(file, "utf8");
      const label = relative(repositoryRoot, file).replaceAll("\\", "/");
      if (/firstTenant/.test(content)) {
        violations.push(`${label}: tenant selection must come from grants, not firstTenant`);
      }
      if (/localStorage|sessionStorage|\bBearer\b|accessToken|tokenType|authorization\s*[:=]/i.test(content)) {
        violations.push(`${label}: browser-accessible bearer/session storage`);
      }
      for (const pattern of cell.forbidden) {
        if (pattern.test(content)) violations.push(`${label}: foreign product marker ${pattern}`);
      }
    }
  }

  const legacyRoot = join(repositoryRoot, "apps/web-console");
  const legacyManifest = JSON.parse(await readFile(join(legacyRoot, "package.json"), "utf8"));
  if (legacyManifest.name !== "@hyperion/web-console-legacy") {
    violations.push("apps/web-console must be the legacy edge redirector");
  }
  const legacyFiles = await walkConsoleBoundaryFiles(legacyRoot);
  for (const file of legacyFiles) {
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
    const content = await readFile(file, "utf8");
    const selectorViolation = legacyMultiproductSelectorViolation(content);
    if (selectorViolation) {
      violations.push(`${relative(repositoryRoot, file).replaceAll("\\", "/")}: ${selectorViolation}`);
    }
  }
  const legacySource = legacyFiles
    .filter((file) => relative(legacyRoot, file).replaceAll("\\", "/").startsWith("src/"))
    .map((file) => relative(join(legacyRoot, "src"), file).replaceAll("\\", "/"));
  const legacyAllowlist = new Set(["main.ts", "redirects.test.ts", "redirects.ts", "styles.css"]);
  for (const file of legacySource) {
    if (!legacyAllowlist.has(file))
      violations.push(`apps/web-console/src/${file}: product code remains in legacy edge`);
  }
  return violations;
}

async function main() {
  const violations = await checkConsoleBoundaries();
  if (violations.length) {
    console.error(`Frontend federation boundary failed (${violations.length}):`);
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`Frontend federation boundary OK (${cells.length} product/admin consoles + legacy edge)`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}

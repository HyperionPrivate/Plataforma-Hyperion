import { verifyConsoleBundle } from "@hyperion/frontend-build-provenance";
import { dirname, resolve } from "node:path";
import { argv, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function validateLumenEndpoints(contents) {
  const endpoints = new Set(contents.match(/\/v1\/[A-Za-z0-9_?=&${}/.:-]+/gu) ?? []);
  const allowedEndpoint = (endpoint) =>
    /^\/v1\/auth\/(?:login|logout|session)$/u.test(endpoint) ||
    endpoint === "/v1/lumen/health" ||
    /^\/v1\/tenants\/\$\{[^}]+\}\/lumen\//u.test(endpoint);
  const foreignEndpoints = [...endpoints].filter((endpoint) => !allowedEndpoint(endpoint));
  if (foreignEndpoints.length > 0) {
    throw new Error(`Endpoint outside the LUMEN BFF allowlist: ${foreignEndpoints.join(", ")}`);
  }
}

export const LUMEN_BUNDLE_POLICY = Object.freeze({
  allowedHyperionDependencies: ["lumen-contracts", "platform-contracts"],
  allowedWorkspaceFiles: ["apps/lumen-console/index.html"],
  allowedWorkspaceRoots: ["apps/lumen-console/src/", "packages/lumen-contracts/", "packages/platform-contracts/"],
  displayName: "LUMEN",
  entryModule: "workspace:apps/lumen-console/src/main.tsx",
  forbiddenMarkers: [
    { label: "foreign product marker", pattern: /\b(?:pulso|nova|coopfuturo)\b/iu },
    { label: "customer brand", pattern: /brand-coopfuturo/iu },
    { label: "legacy product selector", pattern: /VITE_PRODUCT/iu },
    { label: "browser token model", pattern: /localStorage|sessionStorage|\bBearer\b|accessToken|tokenType/u },
    { label: "foreign product route", pattern: /\/(?:operacion|campanas|configuracion)(?:\b|\/)/iu }
  ],
  metafileName: "lumen-bundle-metafile.json",
  product: "lumen",
  validateContents: validateLumenEndpoints
});

export function verifyLumenBundle(options = {}) {
  return verifyConsoleBundle(LUMEN_BUNDLE_POLICY, {
    appRoot: options.appRoot ?? appRoot,
    distRoot: options.distRoot
  });
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyLumenBundle();
  stdout.write(
    `LUMEN bundle provenance OK (${result.modules} modules, ${result.chunks} chunks, ${result.outputs} outputs).\n`
  );
}

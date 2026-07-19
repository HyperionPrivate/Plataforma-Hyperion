import { verifyConsoleBundle } from "@hyperion/frontend-build-provenance";
import { dirname, resolve } from "node:path";
import { argv, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const PULSO_BUNDLE_POLICY = Object.freeze({
  allowedHyperionDependencies: ["platform-contracts", "pulso-contracts"],
  allowedWorkspaceFiles: ["apps/pulso-console/index.html"],
  allowedWorkspaceRoots: ["apps/pulso-console/src/", "packages/platform-contracts/", "packages/pulso-contracts/"],
  displayName: "PULSO",
  entryModule: "workspace:apps/pulso-console/src/main.tsx",
  forbiddenMarkers: [
    { label: "NOVA route", pattern: /\/nova\b/iu },
    { label: "LUMEN route", pattern: /\/lumen\b/iu },
    { label: "customer brand", pattern: /brand-coopfuturo|coopfuturo/iu },
    { label: "legacy product selector", pattern: /VITE_PRODUCT|VITE_BRAND_LABEL/iu },
    { label: "browser token model", pattern: /localStorage|sessionStorage|\bBearer\b|accessToken|tokenType/u }
  ],
  metafileName: "pulso-bundle-metafile.json",
  product: "pulso"
});

export function verifyPulsoBundle(options = {}) {
  return verifyConsoleBundle(PULSO_BUNDLE_POLICY, {
    appRoot: options.appRoot ?? appRoot,
    distRoot: options.distRoot
  });
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyPulsoBundle();
  stdout.write(
    `PULSO bundle provenance OK (${result.modules} modules, ${result.chunks} chunks, ${result.outputs} outputs).\n`
  );
}

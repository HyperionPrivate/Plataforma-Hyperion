import { verifyConsoleBundle } from "@hyperion/frontend-build-provenance";
import { dirname, resolve } from "node:path";
import { argv, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export const PLATFORM_ADMIN_BUNDLE_POLICY = Object.freeze({
  allowedHyperionDependencies: ["platform-contracts"],
  allowedWorkspaceFiles: ["apps/platform-admin-console/index.html"],
  allowedWorkspaceRoots: ["apps/platform-admin-console/src/", "packages/platform-contracts/"],
  displayName: "Platform admin",
  entryModule: "workspace:apps/platform-admin-console/src/main.tsx",
  forbiddenMarkers: [
    { label: "product route or code", pattern: /\/nova\b|\/lumen\b|pulso-iris/iu },
    { label: "customer brand", pattern: /brand-coopfuturo/iu },
    { label: "browser token model", pattern: /localStorage|sessionStorage|\bBearer\b|accessToken|tokenType/u }
  ],
  metafileName: "platform-admin-bundle-metafile.json",
  product: "platform-admin"
});

export function verifyPlatformAdminBundle(options = {}) {
  return verifyConsoleBundle(PLATFORM_ADMIN_BUNDLE_POLICY, {
    appRoot: options.appRoot ?? appRoot,
    distRoot: options.distRoot
  });
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyPlatformAdminBundle();
  stdout.write(
    `Platform admin bundle provenance OK (${result.modules} modules, ${result.chunks} chunks, ${result.outputs} outputs).\n`
  );
}

import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type ResolvedConfig } from "vite";

const devApiTarget = process.env.NOVA_BFF_DEV_TARGET ?? "http://127.0.0.1:8095";
const appRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(appRoot, "../..");
const metafileName = "nova-bundle-metafile.json";

type RollupOutputProvenance = {
  dynamicImports: string[];
  facadeModuleId: string | null;
  imports: string[];
  isEntry: boolean;
  modules: string[];
  type: "asset" | "chunk";
};

function posixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function splitModuleSuffix(moduleId: string): { path: string; suffix: string } {
  const suffixIndex = moduleId.search(/[?#]/);
  return suffixIndex === -1
    ? { path: moduleId, suffix: "" }
    : { path: moduleId.slice(0, suffixIndex), suffix: moduleId.slice(suffixIndex) };
}

function portableFileModuleId(moduleId: string, suffix: string): string {
  let modulePath = moduleId;
  if (modulePath.startsWith("/@fs/")) modulePath = modulePath.slice("/@fs/".length);
  if (!isAbsolute(modulePath)) return `unresolved:${posixPath(modulePath)}${suffix}`;

  const workspacePath = relative(workspaceRoot, modulePath);
  if (workspacePath === "" || (!workspacePath.startsWith("..") && !isAbsolute(workspacePath))) {
    return `workspace:${posixPath(workspacePath || ".")}${suffix}`;
  }
  return `external:${posixPath(modulePath)}${suffix}`;
}

function portableModuleId(moduleId: string): string {
  const virtual = moduleId.startsWith("\0");
  const unwrapped = virtual ? moduleId.slice(1) : moduleId;
  const { path, suffix } = splitModuleSuffix(unwrapped);

  if (virtual && isAbsolute(path)) {
    return `virtual-file:${portableFileModuleId(path, suffix)}`;
  }
  if (virtual) return `virtual:${posixPath(unwrapped)}`;
  return portableFileModuleId(path, suffix);
}

function outputFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`NOVA build output cannot contain a symbolic link: ${path}`);
      }
      return entry.isDirectory() ? outputFiles(path) : [path];
    });
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Emits a deterministic, path-portable provenance manifest after Vite/Rollup has
 * finished writing. The checker consumes this instead of inferring ownership from
 * minified text markers alone.
 */
function novaBundleMetafilePlugin(): Plugin {
  let resolvedConfig: ResolvedConfig;
  let loadedModules: string[] = [];
  const rollupOutputs = new Map<string, RollupOutputProvenance>();

  return {
    name: "nova-bundle-metafile",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      resolvedConfig = config;
    },
    generateBundle: {
      order: "post",
      handler(_outputOptions, bundle) {
        loadedModules = [...this.getModuleIds()].map(portableModuleId).sort();
        rollupOutputs.clear();

        for (const output of Object.values(bundle)) {
          if (output.type === "asset") {
            rollupOutputs.set(posixPath(output.fileName), {
              dynamicImports: [],
              facadeModuleId: null,
              imports: [],
              isEntry: false,
              modules: [],
              type: "asset"
            });
            continue;
          }

          rollupOutputs.set(posixPath(output.fileName), {
            dynamicImports: [...output.dynamicImports].map(posixPath).sort(),
            facadeModuleId: output.facadeModuleId ? portableModuleId(output.facadeModuleId) : null,
            imports: [...output.imports].map(posixPath).sort(),
            isEntry: output.isEntry,
            modules: Object.keys(output.modules).map(portableModuleId).sort(),
            type: "chunk"
          });
        }
      }
    },
    closeBundle: {
      order: "post",
      handler() {
        const outDir = resolve(resolvedConfig.root, resolvedConfig.build.outDir);
        const metafilePath = join(outDir, metafileName);
        rmSync(metafilePath, { force: true });

        const outputs = outputFiles(outDir).map((path) => {
          const fileName = posixPath(relative(outDir, path));
          const contents = readFileSync(path);
          const rollup = rollupOutputs.get(fileName) ?? {
            dynamicImports: [],
            facadeModuleId: null,
            imports: [],
            isEntry: false,
            modules: [],
            type: "asset" as const
          };
          return {
            fileName,
            bytes: statSync(path).size,
            sha256: sha256(contents),
            ...rollup
          };
        });

        const metafile = {
          schemaVersion: 1,
          kind: "vite-rollup-build",
          product: "nova",
          entryModule: "workspace:apps/nova-console/src/main.tsx",
          modules: [...new Set(loadedModules)],
          outputs
        };
        writeFileSync(metafilePath, `${JSON.stringify(metafile, null, 2)}\n`, "utf8");
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), novaBundleMetafilePlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "charts-vendor": ["recharts"],
          "react-vendor": ["react", "react-dom", "react-router-dom"]
        }
      }
    }
  },
  server: {
    host: "0.0.0.0",
    port: 3010,
    proxy: {
      "/api": {
        target: devApiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  },
  preview: {
    host: "0.0.0.0",
    port: 3010
  }
});

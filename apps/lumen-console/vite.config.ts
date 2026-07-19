import { createViteBundleProvenancePlugin } from "@hyperion/frontend-build-provenance";
import react from "@vitejs/plugin-react";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const devBffTarget = process.env.LUMEN_BFF_DEV_TARGET ?? "http://127.0.0.1:8096";
const appRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    createViteBundleProvenancePlugin({
      appRoot,
      entryModule: "workspace:apps/lumen-console/src/main.tsx",
      metafileName: "lumen-bundle-metafile.json",
      product: "lumen"
    })
  ],
  server: {
    host: "0.0.0.0",
    port: 3002,
    proxy: {
      "/api": {
        target: devBffTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  },
  preview: {
    host: "0.0.0.0",
    port: 3002
  }
});

import { createViteBundleProvenancePlugin } from "@hyperion/frontend-build-provenance";
import react from "@vitejs/plugin-react";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const devApiTarget = process.env.PULSO_DEV_BFF_TARGET ?? "http://127.0.0.1:8097";
const appRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    createViteBundleProvenancePlugin({
      appRoot,
      entryModule: "workspace:apps/pulso-console/src/main.tsx",
      metafileName: "pulso-bundle-metafile.json",
      product: "pulso"
    })
  ],
  server: {
    host: "0.0.0.0",
    port: 3000,
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
    port: 3000
  }
});

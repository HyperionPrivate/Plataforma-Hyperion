import { createViteBundleProvenancePlugin } from "@hyperion/frontend-build-provenance";
import react from "@vitejs/plugin-react";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const devApiTarget = process.env.PLATFORM_ADMIN_DEV_API_TARGET ?? "http://127.0.0.1:8098";
const appRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    createViteBundleProvenancePlugin({
      appRoot,
      entryModule: "workspace:apps/platform-admin-console/src/main.tsx",
      metafileName: "platform-admin-bundle-metafile.json",
      product: "platform-admin"
    })
  ],
  server: {
    host: "0.0.0.0",
    port: 3003,
    proxy: {
      "/api": {
        target: devApiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  },
  preview: { host: "0.0.0.0", port: 3003 }
});

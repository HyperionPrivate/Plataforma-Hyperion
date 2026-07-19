import { LUMEN_CURRENT_SCHEMA_VERSION } from "@hyperion/lumen-migrations/schema-manifest";
import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "lumen-service",
  databaseRequired: true,
  requiredSchemaVersion: {
    schema: "lumen",
    serviceName: "lumen",
    minimumVersion: LUMEN_CURRENT_SCHEMA_VERSION
  },
  registerRoutes
});

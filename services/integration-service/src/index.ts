import { startService } from "@hyperion/service-runtime";
import { PULSO_CURRENT_SCHEMA_VERSION } from "@hyperion/pulso-migrations/schema-manifest";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "integration-service",
  databaseRequired: true,
  requiredSchemaVersion: {
    schema: "pulso_iris",
    serviceName: "pulso",
    minimumVersion: PULSO_CURRENT_SCHEMA_VERSION
  },
  registerRoutes
});

import { startService } from "@hyperion/service-runtime";
import { PULSO_RUNTIME_SCHEMA_REQUIREMENTS } from "@hyperion/pulso-migrations/schema-manifest";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "integration-service",
  databaseRequired: true,
  requiredSchemaVersion: PULSO_RUNTIME_SCHEMA_REQUIREMENTS.pulso,
  registerRoutes
});

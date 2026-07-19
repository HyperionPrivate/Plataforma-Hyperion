import { ACCESS_RUNTIME_MIGRATION_REQUIREMENT } from "@hyperion/access-migrations/schema-manifest";
import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "identity-service",
  databaseRequired: true,
  requiredMigrationLedger: ACCESS_RUNTIME_MIGRATION_REQUIREMENT,
  registerRoutes
});

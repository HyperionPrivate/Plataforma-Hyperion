import { AUDIT_RUNTIME_MIGRATION_REQUIREMENT } from "@hyperion/audit-migrations/schema-manifest";
import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "audit-service",
  databaseRequired: true,
  requiredMigrationLedger: AUDIT_RUNTIME_MIGRATION_REQUIREMENT,
  registerRoutes
});

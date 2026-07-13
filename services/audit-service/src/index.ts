import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "audit-service",
  databaseRequired: true,
  requiredMigrations: [
    "001-platform.sql",
    "021-autonomous-event-flow.sql",
    "025-audit-ledger-autonomy.sql",
    "026-audit-source-provenance.sql"
  ],
  registerRoutes
});

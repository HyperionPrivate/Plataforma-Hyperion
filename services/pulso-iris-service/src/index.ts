import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "pulso-iris-service",
  databaseRequired: true,
  requiredMigrations: [
    "006-tenant-isolation.sql",
    "008-agenda-configuration.sql",
    "009-agenda-slot-engine.sql",
    "010-agenda-rules.sql",
    "011-configurable-agenda.sql"
  ],
  registerRoutes
});

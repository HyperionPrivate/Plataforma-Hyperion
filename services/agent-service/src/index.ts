import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "agent-service",
  databaseRequired: true,
  requiredMigrations: [
    "001-platform.sql",
    "012-whatsapp-sofia-runtime.sql",
    "013-sofia-confirmation-protocol.sql",
    "014-sofia-local-time-protocol.sql",
    "015-sofia-fresh-availability.sql"
  ],
  registerRoutes
});

import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "whatsapp-channel-service",
  databaseRequired: true,
  requiredMigrations: ["012-whatsapp-sofia-runtime.sql", "017-whatsapp-channel-durability.sql"],
  registerRoutes
});

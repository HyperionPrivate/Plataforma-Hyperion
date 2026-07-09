import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "prompt-flow-service",
  databaseRequired: true,
  requiredMigrations: ["001-platform.sql", "012-whatsapp-sofia-runtime.sql"],
  registerRoutes
});

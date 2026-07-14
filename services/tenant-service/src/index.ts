import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "tenant-service",
  databaseRequired: true,
  requiredMigrations: ["001-platform.sql"],
  registerRoutes
});

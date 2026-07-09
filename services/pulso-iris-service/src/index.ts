import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "pulso-iris-service",
  databaseRequired: true,
  requiredMigrations: ["006-tenant-isolation.sql"],
  registerRoutes
});

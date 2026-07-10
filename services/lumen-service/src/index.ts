import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "lumen-service",
  databaseRequired: true,
  requiredMigrations: ["018-lumen-clinical-demo.sql", "019-lumen-clinical-invariants.sql"],
  registerRoutes
});

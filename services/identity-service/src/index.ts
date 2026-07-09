import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "identity-service",
  databaseRequired: true,
  requiredMigrations: ["003-identity-auth.sql", "007-operator-roles.sql"],
  registerRoutes
});

import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "audit-service",
  databaseRequired: true,
  registerRoutes
});

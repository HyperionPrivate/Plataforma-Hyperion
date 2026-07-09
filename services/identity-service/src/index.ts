import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "identity-service",
  databaseRequired: true,
  registerRoutes
});

import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "lumen-service",
  databaseRequired: true,
  requiredSchemaVersion: {
    schema: "lumen",
    serviceName: "lumen",
    minimumVersion: 26
  },
  registerRoutes
});

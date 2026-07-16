import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "nova-core-service",
  databaseRequired: true,
  requiredSchemaVersion: {
    schema: "nova",
    serviceName: "nova",
    minimumVersion: 2
  },
  registerRoutes
});

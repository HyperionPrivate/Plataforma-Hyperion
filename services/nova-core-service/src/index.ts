import { startService } from "@hyperion/nova-service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "nova-core-service",
  databaseRequired: true,
  requiredSchemaVersion: {
    schema: "nova",
    serviceName: "nova",
    minimumVersion: 8
  },
  registerRoutes
});

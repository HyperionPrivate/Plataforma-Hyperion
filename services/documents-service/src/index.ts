import { startService } from "@hyperion/nova-service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "documents-service",
  databaseRequired: true,
  requiredSchemaVersion: {
    schema: "documents",
    serviceName: "documents",
    minimumVersion: 2
  },
  registerRoutes
});

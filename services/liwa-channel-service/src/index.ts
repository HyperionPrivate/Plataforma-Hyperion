import { startService } from "@hyperion/nova-service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "liwa-channel-service",
  databaseRequired: true,
  requiredSchemaVersion: {
    schema: "liwa",
    serviceName: "liwa",
    minimumVersion: 3
  },
  registerRoutes
});

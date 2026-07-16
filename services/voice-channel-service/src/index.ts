import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "voice-channel-service",
  databaseRequired: true,
  requiredSchemaVersion: {
    schema: "voice",
    serviceName: "voice",
    minimumVersion: 2
  },
  registerRoutes
});

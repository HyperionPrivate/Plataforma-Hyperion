import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "pulso-iris-service",
  databaseRequired: true,
  registerRoutes
});

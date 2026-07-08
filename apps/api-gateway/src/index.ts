import { startService } from "@hyperion/service-runtime";
import { registerRoutes } from "./app.js";

await startService({
  serviceName: "api-gateway",
  databaseRequired: false,
  publicApi: true,
  registerRoutes
});
